import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Query, errorText, parse } from "../ct/client.js";
import { type Session, loginRequired } from "../ct/session.js";
import { type Change, type Plans, changedOnly, readGuarded } from "../plans.js";
import { id, parseList, plan, read } from "./common.js";
import { toolResult } from "./result.js";

const eventId = id.describe("The event's id");
const eventServiceId = id.describe(
  "The id of one assignment in the event's eventServices (ct_get_event), not the serviceId",
);
const day = z.iso.date();
const assigneeName = z.string().trim().min(2).max(255);
const comment = z.string().max(255);

/** One assignment as ChurchTools embeds it in an event; a missing, null or `[]` person reads as no person. */
const assignment = z
  .object({
    id: z.number(),
    serviceId: z.number().nullish(),
    personId: z.number().nullish(),
    person: z.object({ title: z.string().nullish() }).catch({}),
    name: z.string().nullish(),
    isAccepted: z.boolean().nullish(),
    agreed: z.boolean().nullish(),
    isValid: z.boolean().nullish(),
  })
  .transform((a) => ({
    id: a.id,
    serviceId: a.serviceId,
    personId: a.personId,
    name: a.person.title ?? a.name,
    // `agreed` is the deprecated name of isAccepted.
    isAccepted: a.isAccepted ?? a.agreed,
    isValid: a.isValid,
  }));
type Assignment = z.infer<typeof assignment>;
/** Unreadable entries are dropped, the rest stays; anything but an array is no assignment. */
const assignments = z
  .array(assignment.optional().catch(undefined))
  .catch([])
  .transform((list) => list.filter((a) => a !== undefined));

const compactEvent = z.object({
  id: z.number(),
  name: z.string().nullish(),
  startDate: z.string().nullish(),
  endDate: z.string().nullish(),
  isCanceled: z.boolean().nullish(),
  eventServices: assignments,
});
/** The whole event; its other fields pass through unchanged. */
const storedEvent = z.looseObject({
  id: z.number(),
  name: z.string().nullish().catch(undefined),
  startDate: z.string().nullish().catch(undefined),
  eventServices: assignments,
});
const eventRecord = z.object({ data: storedEvent });
const service = z.object({
  id: z.number(),
  name: z.string().nullish(),
  serviceGroupId: z.number().nullish(),
});
const serviceGroup = z.object({ id: z.number(), name: z.string().nullish() });

/** "event 12 (Sunday gathering on 2026-10-11T08:00:00Z)", or "event 12" without a name. */
function label(
  eventId: number,
  { name, startDate }: { name?: string | null; startDate?: string | null },
) {
  if (!name) return `event ${eventId}`;
  return startDate
    ? `event ${eventId} (${name} on ${startDate})`
    : `event ${eventId} (${name})`;
}

/** The day after a YYYY-MM-DD day: GET /events leaves out its `to` day. */
const nextDay = (date: string) =>
  new Date(Date.parse(date) + 86_400_000).toISOString().slice(0, 10);

const listInput = z
  .object({
    from: day.optional().describe("First day, YYYY-MM-DD"),
    to: day
      .optional()
      .describe(
        "Last day, YYYY-MM-DD, included. Without it, ChurchTools reads up to today plus two months",
      ),
    canceled: z.boolean().optional().describe("true includes canceled events"),
  })
  .refine(
    ({ from, to }) => !from || !to || from <= to,
    "to must not be before from",
  );

/** Registers the event and service tools: reads answer at once, writes return a plan for ct_execute_plan. */
export function registerEventTools(
  server: McpServer,
  { session, plans }: { session: Pick<Session, "use">; plans: Plans },
): void {
  const get = (path: string, query?: Query) =>
    session.use((client) => client.request("GET", path, { query }));

  /** The name of a service by its id; a failed read, except a lost login, names each "(unknown: <reason>)". */
  async function serviceNames(): Promise<
    (serviceId: number) => string | null | undefined
  > {
    try {
      const { data } = parseList(service, await get("/services"), "/services");
      const names = new Map(data.map((s) => [s.id, s.name]));
      return (serviceId) => names.get(serviceId);
    } catch (error) {
      if (error instanceof Error && error.message === loginRequired)
        throw error;
      return () => `(unknown: ${errorText(error)})`;
    }
  }

  const withServiceName = (
    a: Assignment,
    nameOf: Awaited<ReturnType<typeof serviceNames>>,
  ) => ({
    ...a,
    serviceName: a.serviceId == null ? undefined : nameOf(a.serviceId),
  });

  /** The guarded event, its label and the assignment `eventServiceId` names with its service name. */
  async function readAssignment(eventId: number, eventServiceId: number) {
    const path = `/events/${eventId}`;
    const { guard, before } = await readGuarded(session, path);
    const stored = parse(storedEvent, before, path);
    const event = label(eventId, stored);
    const current = stored.eventServices.find((a) => a.id === eventServiceId);
    if (!current) {
      const known = stored.eventServices.map((a) => a.id).join(", ");
      throw new Error(
        `${event} has no service assignment ${eventServiceId}; its eventServices ids are ${known || "none"} (ct_get_event)`,
      );
    }
    const assigned = withServiceName(current, await serviceNames());
    const service = `${assigned.serviceName ?? `service ${current.serviceId ?? "unknown"}`} (assignment ${eventServiceId})`;
    return { guard, event, service, assigned };
  }

  /** A plan for one assignment write, guarded by the event; the preview adds the assignment as it is now. */
  async function assignmentPlan(
    eventId: number,
    eventServiceId: number,
    summary: (service: string, event: string) => string,
    change: Change,
  ) {
    const { guard, event, service, assigned } = await readAssignment(
      eventId,
      eventServiceId,
    );
    const { token, preview } = plans.createPlan({
      summary: summary(service, event),
      changes: [change],
      guards: [guard],
    });
    return { token, preview: { ...preview, currentAssignment: assigned } };
  }

  server.registerTool(
    "ct_list_events",
    {
      title: "List ChurchTools events",
      description:
        "Lists the events in a date range with id, name, start, end, canceled state and their service assignments (id, serviceId, personId, assignee name, isAccepted, isValid). Use ct_get_event for service names and the whole event.",
      inputSchema: listInput,
      annotations: read,
    },
    ({ to, ...input }) =>
      toolResult(async () => {
        const answer = await get("/events", {
          ...input,
          to: to && nextDay(to),
          include: "eventServices",
        });
        return { events: parseList(compactEvent, answer, "/events").data };
      }),
  );

  server.registerTool(
    "ct_get_event",
    {
      title: "Get a ChurchTools event",
      description:
        "Shows the whole event with each service assignment: its id (the eventServiceId of the service tools), serviceId, service name, personId, assignee name, isAccepted and isValid (false for a superseded or declined assignment).",
      inputSchema: z.object({ eventId }),
      annotations: read,
    },
    ({ eventId }) =>
      toolResult(async () => {
        const path = `/events/${eventId}`;
        const { data } = parse(eventRecord, await get(path), path);
        const names = await serviceNames();
        return {
          ...data,
          eventServices: data.eventServices.map((a) =>
            withServiceName(a, names),
          ),
        };
      }),
  );

  server.registerTool(
    "ct_list_services",
    {
      title: "List ChurchTools services",
      description:
        "Lists every service (e.g. sermon, sound) with id, name, service group id and service group name.",
      annotations: read,
    },
    () =>
      toolResult(async () => {
        const services = parseList(
          service,
          await get("/services"),
          "/services",
        );
        // The services stand on their own; missing group names are said, not fatal.
        let groups: z.infer<typeof serviceGroup>[];
        try {
          groups = parseList(
            serviceGroup,
            await get("/servicegroups"),
            "/servicegroups",
          ).data;
        } catch (error) {
          if (error instanceof Error && error.message === loginRequired)
            throw error;
          return {
            services: services.data,
            serviceGroupNames: `not read: ${errorText(error)}`,
          };
        }
        const groupNames = new Map(groups.map((g) => [g.id, g.name]));
        return {
          services: services.data.map((s) => ({
            ...s,
            serviceGroupName:
              s.serviceGroupId == null
                ? undefined
                : groupNames.get(s.serviceGroupId),
          })),
        };
      }),
  );

  server.registerTool(
    "ct_update_event",
    {
      title: "Plan a change to a ChurchTools event",
      description:
        "Writes nothing: returns a plan that changes whether the event is canceled, its note or its admins; ChurchTools takes no other event field here. Only fields whose value changes are sent.",
      inputSchema: z.strictObject({
        eventId,
        isCanceled: z.boolean().optional().describe("true cancels the event"),
        note: z
          .string()
          .max(4000)
          .nullable()
          .optional()
          .describe("The event's note, up to 4000 characters; null clears it"),
        adminIds: z
          .array(id)
          .optional()
          .describe("The person ids of the event's admins; replaces the list"),
      }),
      annotations: plan,
    },
    ({ eventId, ...changes }) =>
      toolResult(async () => {
        if (Object.values(changes).every((value) => value === undefined)) {
          throw new Error(
            "Name at least one change: isCanceled, note or adminIds",
          );
        }
        const path = `/events/${eventId}`;
        const { guard, before } = await readGuarded(session, path);
        const event = label(eventId, parse(storedEvent, before, path));
        const body = changedOnly(before, changes);
        if (Object.keys(body).length === 0) {
          throw new Error(`No change: ${event} already has these values`);
        }
        return plans.createPlan({
          summary: `Update ${event}`,
          changes: [{ method: "PUT", path, body, before }],
          guards: [guard],
        });
      }),
  );

  server.registerTool(
    "ct_delete_event",
    {
      title: "Plan to delete a ChurchTools event",
      description:
        "Writes nothing: returns a plan to delete an event with its service assignments; the preview shows the whole event, as a delete cannot be undone.",
      inputSchema: z.strictObject({
        eventId,
        sendMail: z
          .boolean()
          .default(false)
          .describe("true emails the affected persons about the delete"),
      }),
      annotations: plan,
    },
    ({ eventId, sendMail }) =>
      toolResult(async () => {
        const path = `/events/${eventId}`;
        const { guard, before } = await readGuarded(session, path);
        const stored = storedEvent.safeParse(before).data ?? {};
        const mail = sendMail ? " and email the affected persons" : "";
        return plans.createPlan({
          summary: `Delete ${label(eventId, stored)}${mail}`,
          changes: [{ method: "DELETE", path, query: { sendMail }, before }],
          guards: [guard],
        });
      }),
  );

  server.registerTool(
    "ct_assign_event_service",
    {
      title:
        "Plan to assign a ChurchTools person or a name to an event service",
      description:
        "Writes nothing: returns a plan that assigns one service assignment of an event (ct_get_event) to a ChurchTools person (personId) or to a name; give exactly one. For a helper without a ChurchTools account, ct_set_external_event_service is the alternative. ChurchTools gives the filled assignment a new id; ct_get_event shows it.",
      inputSchema: z
        .strictObject({
          eventId,
          eventServiceId,
          personId: id.optional().describe("The ChurchTools person's id"),
          name: assigneeName
            .optional()
            .describe("The assignee's name, 2-255 characters"),
          isAccepted: z
            .boolean()
            .default(false)
            .describe("true when the assignee already accepted"),
          comment: comment.optional().describe("Up to 255 characters"),
        })
        .refine(
          ({ personId, name }) =>
            (personId === undefined) !== (name === undefined),
          "Give exactly one of personId and name",
        ),
      annotations: plan,
    },
    ({ eventId, eventServiceId, ...body }) =>
      toolResult(() => {
        const who = body.name ?? `person ${body.personId}`;
        return assignmentPlan(
          eventId,
          eventServiceId,
          (service, event) => `Assign ${who} to ${service} of ${event}`,
          {
            method: "PUT",
            path: `/events/${eventId}/servicerequests/${eventServiceId}`,
            body,
          },
        );
      }),
  );

  server.registerTool(
    "ct_set_external_event_service",
    {
      title: "Plan to give an event service to a helper outside ChurchTools",
      description:
        "Writes nothing: returns a plan that fills one service assignment of an event (ct_get_event) with the name of a helper who has no ChurchTools account. For a ChurchTools person use ct_assign_event_service. ChurchTools gives the filled assignment a new id; ct_get_event shows it.",
      inputSchema: z.strictObject({
        eventId,
        eventServiceId,
        name: assigneeName.describe("The helper's name, 2-255 characters"),
        agreed: z
          .boolean()
          .default(false)
          .describe("true when the helper already agreed"),
        comment: comment.optional().describe("Up to 255 characters"),
      }),
      annotations: plan,
    },
    ({ eventId, eventServiceId, name, agreed, comment }) =>
      toolResult(() =>
        assignmentPlan(
          eventId,
          eventServiceId,
          (service, event) =>
            `Set external helper ${name} for ${service} of ${event}`,
          {
            method: "PUT",
            path: `/events/${eventId}/eventservices/${eventServiceId}`,
            body: { eventId, eventServiceId, name, agreed, comment },
          },
        ),
      ),
  );
}
