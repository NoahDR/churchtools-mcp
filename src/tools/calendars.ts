import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Query, parse } from "../ct/client.js";
import type { Session } from "../ct/session.js";
import { type Plans, changedOnly, readGuarded } from "../plans.js";
import { id, parseList, plan, read } from "./common.js";
import { toolResult } from "./result.js";

const calendarId = id.describe("The calendar's id");
const appointmentId = id.describe(
  "The appointment's id; one id covers every occurrence of a series",
);
const day = z.iso.date();
const title = z.string().trim().min(1, "must not be blank");
const dateOrTime = z
  .union([z.iso.datetime({ precision: 0 }), day])
  .describe(
    "YYYY-MM-DDTHH:mm:ssZ in UTC, or YYYY-MM-DD for an all-day appointment",
  );
const isInternal = z
  .boolean()
  .describe(
    "false for a regular appointment; true only when it is visible exclusively to signed-in users",
  );
/** These go by their own parameter; `fields` must not name them. */
const ownKeys = [
  "calendarId",
  "appointmentId",
  "title",
  "startDate",
  "endDate",
  "isInternal",
];
/** Deprecated response-only names and the field each stands for; the PUT body declares none of them. */
const aliases: Record<string, string> = {
  caption: "title",
  information: "description",
  note: "subtitle",
  additions: "additionals",
  "@deprecated": "the field it names",
};
const fields = z
  .record(z.string(), z.unknown())
  .superRefine((f, ctx) => {
    for (const key of Object.keys(f)) {
      if (ownKeys.includes(key)) {
        ctx.addIssue({
          code: "custom",
          message: `${key} is a parameter of its own, not a field`,
        });
      } else if (Object.hasOwn(aliases, key)) {
        ctx.addIssue({
          code: "custom",
          message: `${key} is deprecated; use ${aliases[key]}`,
        });
      }
    }
  })
  .optional()
  .describe(
    "Further fields of the appointment, e.g. subtitle, description, link, address, repeatId (0 once, 1 daily, 7 weekly, 31 monthly by date, 32 monthly by weekday, 365 yearly, 999 manual dates), repeatFrequency, repeatUntil (YYYY-MM-DD); null clears a field",
  );

/** A list shows these fields only. */
const compactCalendar = z.object({
  id: z.number(),
  name: z.string().nullish(),
  nameTranslated: z.string().nullish(),
  isPublic: z.boolean().nullish(),
  isPrivate: z.boolean().nullish(),
});
const occurrenceParts = z.object({
  base: z.object({
    id: z.number(),
    title: z.string().nullish(),
    repeatId: z.number().nullish(),
    calendar: z.object({ id: z.number().nullish() }).catch({}),
  }),
  calculated: z
    .object({
      startDate: z.string().nullish(),
      endDate: z.string().nullish(),
    })
    .catch({}),
});
/** One occurrence: `base` is the stored appointment, `calculated` the dates of this occurrence. */
const compactOccurrence = z
  .union([
    z.object({ appointment: occurrenceParts }).transform((i) => i.appointment),
    occurrenceParts,
  ])
  .transform(({ base, calculated }) => ({
    id: base.id,
    calendarId: base.calendar.id,
    title: base.title,
    startDate: calculated.startDate,
    endDate: calculated.endDate,
    repeatId: base.repeatId,
  }));

/** The stored record; its other fields pass through unchanged, as the PUT sends them back. */
const storedAppointment = z.looseObject({ id: z.number(), title: z.string() });
/** GET answers `data.appointment`; a list item nests the same record in `appointment.base`, so that is read too. */
const appointmentData = z.object({
  appointment: z.union([
    z.object({ base: storedAppointment }).transform((a) => a.base),
    storedAppointment,
  ]),
});
const appointmentRecord = z.object({
  data: z.record(z.string(), z.unknown()),
});

/** A stale alias (caption beside title…) is never sent back. */
function withoutAliases(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !Object.hasOwn(aliases, key)),
  );
}

/**
 * The PUT has no allDay: the form of the dates says it (YYYY-MM-DD is all-day). When the dates change,
 * the stored allDay follows the new start, so the body never contradicts its dates.
 */
function allDayFollowsDates(
  stored: Record<string, unknown>,
  changed: Record<string, unknown>,
) {
  if (!("startDate" in changed || "endDate" in changed)) return changed;
  const start = changed.startDate ?? stored.startDate;
  if (typeof start !== "string") return changed;
  const allDay = day.safeParse(start).success;
  return changedOnly(stored, { ...changed, allDay });
}

/** "appointment 42 (Sunday service)", or "appointment 42" without a title. */
function label(appointmentId: number, title?: string) {
  return title
    ? `appointment ${appointmentId} (${title})`
    : `appointment ${appointmentId}`;
}

/** Set unless the record proves a single date: `repeatId` 0 and no additional dates. */
function seriesWarning(
  stored: Record<string, unknown> | undefined,
  change: "update" | "delete",
) {
  const { repeatId, additionals } = stored ?? {};
  const extraDates = Array.isArray(additionals) ? additionals.length : 0;
  if (repeatId === 0 && extraDates === 0) return {};
  const pattern = `repeatId ${typeof repeatId === "number" ? repeatId : "unknown"}, ${extraDates} additional dates`;
  return {
    warning: `This appointment has more than one date (${pattern}): the ${change} applies to the whole series, every date. Editing or deleting a single occurrence is out of scope.`,
  };
}

const listInput = z
  .object({
    calendar_ids: z
      .array(id)
      .min(1)
      .describe("The calendars to read, at least one (ct_list_calendars)"),
    from: day.optional().describe("First day, YYYY-MM-DD"),
    to: day
      .optional()
      .describe("Last day, YYYY-MM-DD; ChurchTools still includes it"),
    query: z.string().optional().describe("Search text"),
  })
  .refine(
    ({ from, to }) => !from || !to || from <= to,
    "to must not be before from",
  );

/** Registers the calendar and appointment tools: reads answer at once, writes return a plan for ct_execute_plan. */
export function registerCalendarTools(
  server: McpServer,
  { session, plans }: { session: Pick<Session, "use">; plans: Plans },
): void {
  const get = (path: string, query?: Query) =>
    session.use((client) => client.request("GET", path, { query }));
  const appointmentPath = (calendarId: number, appointmentId: number) =>
    `/calendars/${calendarId}/appointments/${appointmentId}`;

  server.registerTool(
    "ct_list_calendars",
    {
      title: "List ChurchTools calendars",
      description:
        "Lists every calendar the user can see with id, name and visibility.",
      annotations: read,
    },
    () =>
      toolResult(async () => {
        const answer = await get("/calendars");
        const { data, ...pagination } = parseList(
          compactCalendar,
          answer,
          "/calendars",
        );
        return { calendars: data, ...pagination };
      }),
  );

  server.registerTool(
    "ct_list_appointments",
    {
      title: "List ChurchTools appointments",
      description:
        "Lists the occurrences of appointments in the given calendars and date range, each with appointment id, calendar id, title, the occurrence's start and end, and repeatId (0 once, any other value a series). Use ct_get_appointment for the whole appointment.",
      inputSchema: listInput,
      annotations: read,
    },
    ({ calendar_ids, ...rest }) =>
      toolResult(async () => {
        const path = "/calendars/appointments";
        const answer = await get(path, {
          ...rest,
          "calendar_ids[]": calendar_ids,
        });
        const { data, ...pagination } = parseList(
          compactOccurrence,
          answer,
          path,
        );
        return { appointments: data, ...pagination };
      }),
  );

  server.registerTool(
    "ct_get_appointment",
    {
      title: "Get a ChurchTools appointment",
      description:
        "Shows the stored appointment (for a series: its first occurrence, repeat pattern, exceptions and additional dates) with its calculated dates.",
      inputSchema: z.object({ calendarId, appointmentId }),
      annotations: read,
    },
    ({ calendarId, appointmentId }) =>
      toolResult(async () => {
        const path = appointmentPath(calendarId, appointmentId);
        return parse(appointmentRecord, await get(path), path).data;
      }),
  );

  server.registerTool(
    "ct_create_appointment",
    {
      title: "Plan a new ChurchTools appointment",
      description:
        "Writes nothing: returns a plan to create an appointment, a single one by default or a series through repeatId in fields.",
      inputSchema: z.object({
        calendarId,
        title: title.describe("The appointment's title"),
        startDate: dateOrTime,
        endDate: dateOrTime,
        isInternal: isInternal.default(false),
        fields,
      }),
      annotations: plan,
    },
    ({ calendarId, title, startDate, endDate, isInternal, fields }) =>
      toolResult(async () => {
        const body = {
          ...fields,
          calendarId,
          title,
          startDate,
          endDate,
          isInternal,
        };
        // Nothing to read first, but a plan needs a ready session like every other tool.
        await session.use(() => Promise.resolve());
        return plans.createPlan({
          summary: `Create appointment ${title} in calendar ${calendarId}`,
          changes: [
            {
              method: "POST",
              path: `/calendars/${calendarId}/appointments`,
              body,
            },
          ],
          guards: [],
        });
      }),
  );

  server.registerTool(
    "ct_update_appointment",
    {
      title: "Plan a change to a ChurchTools appointment",
      description:
        "Writes nothing: returns a plan that changes the stored appointment. ChurchTools has no partial update here, so the plan sends the whole current appointment with the changes; the preview lists the changed fields. For a series the change applies to every occurrence.",
      inputSchema: z.object({
        calendarId,
        appointmentId,
        title: title.optional(),
        startDate: dateOrTime.optional(),
        endDate: dateOrTime.optional(),
        isInternal: isInternal.optional(),
        fields,
      }),
      annotations: plan,
    },
    ({ calendarId, appointmentId, fields, ...own }) =>
      toolResult(async () => {
        const changes = { ...fields, ...own };
        if (Object.values(changes).every((value) => value === undefined)) {
          throw new Error(
            "Name at least one change: title, startDate, endDate, isInternal or fields",
          );
        }
        if (fields && "allDay" in fields) {
          throw new Error(
            "allDay is not a field to set: the form of startDate and endDate says it (YYYY-MM-DD is all-day)",
          );
        }
        const path = appointmentPath(calendarId, appointmentId);
        const { guard, before } = await readGuarded(session, path);
        const stored = parse(appointmentData, before, path).appointment;
        const start = own.startDate ?? stored.startDate;
        const end = own.endDate ?? stored.endDate;
        if (
          typeof start === "string" &&
          typeof end === "string" &&
          day.safeParse(start).success !== day.safeParse(end).success
        ) {
          throw new Error(
            `startDate ${start} and endDate ${end} differ in form: give both as YYYY-MM-DD (all-day) or both as a time`,
          );
        }
        const changed = allDayFollowsDates(
          stored,
          changedOnly(stored, changes),
        );
        if (Object.keys(changed).length === 0) {
          throw new Error(
            `No change: ${label(appointmentId, stored.title)} already has these values`,
          );
        }
        // The read proves the record lives at these ids, so they are its values before the change too.
        const current = {
          ...withoutAliases(stored),
          calendarId,
          appointmentId,
        };
        const { token, preview } = plans.createPlan({
          summary: `Update ${label(appointmentId, stored.title)}`,
          changes: [
            {
              method: "PUT",
              path,
              body: { ...current, ...changed },
              before: current,
            },
          ],
          guards: [guard],
        });
        return {
          token,
          preview: {
            ...preview,
            note: "PUT replaces the whole appointment: ChurchTools receives every field of the current appointment, plus calendarId and appointmentId, with the changes above; the other fields are sent unchanged.",
            ...seriesWarning(stored, "update"),
          },
        };
      }),
  );

  server.registerTool(
    "ct_delete_appointment",
    {
      title: "Plan to delete a ChurchTools appointment",
      description:
        "Writes nothing: returns a plan to delete an appointment; for a series every occurrence goes. The preview shows the whole appointment, as a delete cannot be undone.",
      inputSchema: z.object({ calendarId, appointmentId }),
      annotations: plan,
    },
    ({ calendarId, appointmentId }) =>
      toolResult(async () => {
        const path = appointmentPath(calendarId, appointmentId);
        const { guard, before } = await readGuarded(session, path);
        const stored = appointmentData.safeParse(before).data?.appointment;
        const { token, preview } = plans.createPlan({
          summary: `Delete ${label(appointmentId, stored?.title)}`,
          changes: [{ method: "DELETE", path, before }],
          guards: [guard],
        });
        return {
          token,
          preview: {
            ...preview,
            ...seriesWarning(stored, "delete"),
          },
        };
      }),
  );
}
