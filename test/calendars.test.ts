import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, test } from "vitest";
import { loginRequired } from "../src/ct/session.js";
import { createServer } from "../src/server.js";
import {
  code,
  cookieValue,
  env,
  fakeFetch,
  json,
  loginAnswers,
  secrets,
} from "./fake-fetch.js";

const api = "/churchtools/api";
const services = {
  id: 3,
  name: "Services",
  nameTranslated: "Services",
  sortKey: 10,
  color: "#336699",
  isPublic: true,
  isPrivate: false,
  randomUrl: "r-3",
  meta: {},
};
const compactServices = {
  id: 3,
  name: "Services",
  nameTranslated: "Services",
  isPublic: true,
  isPrivate: false,
};
/** A weekly series as GET returns its stored record (`base`). */
const sunday = {
  id: 42,
  title: "Sunday service",
  subtitle: null,
  description: "With choir",
  link: null,
  isInternal: false,
  allDay: false,
  startDate: "2026-10-11T08:00:00Z",
  endDate: "2026-10-11T09:30:00Z",
  repeatId: 7,
  repeatFrequency: 1,
  repeatUntil: "2026-12-20",
  repeatOption: null,
  exceptions: [{ id: 1, date: "2026-10-25", meta: {} }],
  additionals: [],
  address: null,
  signup: null,
  onBehalfOfPid: null,
  image: null,
  version: 3,
  calendar: services,
  meta: { createdDate: "2026-01-01T00:00:00Z" },
};
const elders = {
  ...sunday,
  id: 43,
  title: "Elders meeting",
  repeatId: 0,
  repeatFrequency: null,
  repeatUntil: null,
  exceptions: [],
};
/** GET /calendars/{calendarId}/appointments/{appointmentId} */
const record = (base: object) => ({
  data: { appointment: base, calculatedDates: {}, additionalInfos: [] },
});
const occurrence = {
  appointment: {
    base: sunday,
    calculated: {
      startDate: "2026-10-18T08:00:00Z",
      endDate: "2026-10-18T09:30:00Z",
      iCalUid: "u-42",
    },
  },
};
const compactOccurrence = {
  id: 42,
  calendarId: 3,
  title: "Sunday service",
  startDate: "2026-10-18T08:00:00Z",
  endDate: "2026-10-18T09:30:00Z",
  repeatId: 7,
};
const pagination = { current: 1, lastPage: 2, limit: 10, total: 12 };

async function connectClient(fetch: typeof globalThis.fetch) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await createServer({ env, fetch }).connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

/** A logged-in server whose later requests get `answers`; `calls` holds only those later requests. */
async function ready(answers: (Response | Error)[]) {
  const { fetch, calls } = fakeFetch(...loginAnswers(), ...answers);
  const client = await connectClient(fetch);
  await call(client, "ct_login", { code });
  calls.splice(0);
  const requests = () => calls.map((c) => `${c.method} ${c.path}`);
  const writes = () => calls.filter((c) => c.method !== "GET");
  return { client, calls, requests, writes };
}

async function call(client: Client, name: string, args: unknown = {}) {
  const result = await client.callTool({
    name,
    arguments: args as Record<string, unknown>,
  });
  const [content] = result.content as { type: string; text: string }[];
  const text = content?.text ?? "";
  for (const secret of secrets) expect(text).not.toContain(secret);
  return { isError: result.isError ?? false, text };
}

async function ok(client: Client, name: string, args: unknown = {}) {
  const { isError, text } = await call(client, name, args);
  expect(isError, text).toBe(false);
  return JSON.parse(text) as Record<string, unknown>;
}

async function fails(client: Client, name: string, args: unknown = {}) {
  const { isError, text } = await call(client, name, args);
  expect(isError, text).toBe(true);
  return text;
}

interface Plan {
  token: string;
  preview: {
    summary: string;
    changes: Record<string, unknown>[];
    [key: string]: unknown;
  };
}

async function plan(client: Client, name: string, args: unknown) {
  return (await ok(client, name, args)) as unknown as Plan;
}

const query = (path: string) => new URL(path, "https://x").searchParams;
const sundayPath = `${api}/calendars/3/appointments/42`;

// ct_list_calendars

test("list calendars reads GET /calendars and returns id, names and visibility of each", async () => {
  const { client, requests } = await ready([
    json({ data: [services], meta: { count: 1 } }),
  ]);

  const result = await ok(client, "ct_list_calendars");

  expect(result).toEqual({ calendars: [compactServices] });
  expect(requests()).toEqual([`GET ${api}/calendars`]);
});

test("list calendars keeps a pagination and reads a calendar without display fields", async () => {
  const { client } = await ready([
    json({ data: [{ id: 4 }], meta: { pagination } }),
  ]);

  expect(await ok(client, "ct_list_calendars")).toEqual({
    calendars: [{ id: 4 }],
    pagination,
  });
});

// ct_list_appointments

test("list appointments sends calendar ids, from, to and query to GET /calendars/appointments", async () => {
  const { client, calls, requests } = await ready([json({ data: [] })]);

  await ok(client, "ct_list_appointments", {
    calendar_ids: [3, 4],
    from: "2026-10-01",
    to: "2026-11-01",
    query: "service",
  });

  expect(requests()).toEqual([
    expect.stringMatching(`^GET ${api}/calendars/appointments\\?`),
  ]);
  const sent = query(calls[0]?.path ?? "");
  expect(sent.getAll("calendar_ids[]")).toEqual(["3", "4"]);
  expect(sent.get("from")).toBe("2026-10-01");
  expect(sent.get("to")).toBe("2026-11-01");
  expect(sent.get("query")).toBe("service");
});

test("list appointments reads a single day when from and to are the same, as ChurchTools includes to", async () => {
  const { client, calls } = await ready([json({ data: [] })]);

  await ok(client, "ct_list_appointments", {
    calendar_ids: [3],
    from: "2026-12-25",
    to: "2026-12-25",
  });

  const sent = query(calls[0]?.path ?? "");
  expect(sent.get("from")).toBe("2026-12-25");
  expect(sent.get("to")).toBe("2026-12-25");
});

test("list appointments returns per occurrence id, calendar, title, its dates and the repeat pattern", async () => {
  const { client } = await ready([
    json({ data: [occurrence], meta: { count: 1 } }),
  ]);

  const result = await ok(client, "ct_list_appointments", {
    calendar_ids: [3],
  });

  expect(result).toEqual({ appointments: [compactOccurrence] });
});

test("list appointments also reads base and calculated beside appointment, and keeps a pagination", async () => {
  const { client } = await ready([
    json({ data: [occurrence.appointment], meta: { pagination } }),
  ]);

  const result = await ok(client, "ct_list_appointments", {
    calendar_ids: [3],
  });

  expect(result).toEqual({ appointments: [compactOccurrence], pagination });
});

test("list appointments reads an occurrence without calendar, title or calculated dates", async () => {
  const { client } = await ready([
    json({ data: [{ appointment: { base: { id: 9, calendar: [] } } }] }),
  ]);

  const result = await ok(client, "ct_list_appointments", {
    calendar_ids: [3],
  });

  expect(result).toEqual({ appointments: [{ id: 9 }] });
});

test.each([
  {},
  { calendar_ids: [] },
  { calendar_ids: [0] },
  { calendar_ids: ["3"] },
  { calendar_ids: [3], from: "2026-02-30" },
  { calendar_ids: [3], from: "11.10.2026" },
  { calendar_ids: [3], to: "2026-10-11T00:00:00Z" },
  { calendar_ids: [3], from: "2026-10-11", to: "2026-10-01" },
])("list appointments rejects %j without a request", async (args) => {
  const { client, calls } = await ready([]);

  await fails(client, "ct_list_appointments", args);

  expect(calls).toHaveLength(0);
});

// ct_get_appointment

test("get appointment reads GET /calendars/{calendarId}/appointments/{appointmentId}", async () => {
  const { client, requests } = await ready([json(record(sunday))]);

  const result = await ok(client, "ct_get_appointment", {
    calendarId: 3,
    appointmentId: 42,
  });

  expect(result).toEqual(record(sunday).data);
  expect(requests()).toEqual([`GET ${sundayPath}`]);
});

test("get of an unknown appointment reports the server's message, not the raw body", async () => {
  const { client } = await ready([
    new Response(`<html>${cookieValue}</html>`, { status: 404 }),
    json({ message: "Appointment not found" }, { status: 404 }),
  ]);
  const args = { calendarId: 3, appointmentId: 99 };

  expect(await fails(client, "ct_get_appointment", args)).toContain("HTTP 404");
  expect(await fails(client, "ct_get_appointment", args)).toContain(
    "Appointment not found",
  );
});

// Ids

const badIds = [0, -1, 1.5, "3", null];
const ids = { calendarId: 3, appointmentId: 42 };
const idTools: [string, Record<string, unknown>][] = [
  ["ct_get_appointment", {}],
  ["ct_update_appointment", { title: "x" }],
  ["ct_delete_appointment", {}],
];

test.each(
  idTools.flatMap(([tool, args]) =>
    ["calendarId", "appointmentId"].flatMap((key) =>
      badIds.map((id) => [tool, key, args, id]),
    ),
  ),
)("%s rejects %s %j without a request", async (tool, key, args, id) => {
  const { client, calls } = await ready([]);

  await fails(client, tool as string, {
    ...ids,
    ...(args as object),
    [key as string]: id,
  });

  expect(calls).toHaveLength(0);
});

// Session

const newAppointment = {
  calendarId: 3,
  title: "Harvest festival",
  startDate: "2026-10-04T09:00:00Z",
  endDate: "2026-10-04T12:00:00Z",
};
const everyTool: [string, Record<string, unknown>][] = [
  ["ct_list_calendars", {}],
  ["ct_list_appointments", { calendar_ids: [3] }],
  ["ct_get_appointment", ids],
  ["ct_create_appointment", newAppointment],
  ["ct_update_appointment", { ...ids, title: "x" }],
  ["ct_delete_appointment", ids],
];

test("without a login every calendar tool asks for the 2FA code and sends nothing", async () => {
  const { fetch, calls } = fakeFetch();
  const client = await connectClient(fetch);

  for (const [tool, args] of everyTool) {
    expect(await fails(client, tool, args)).toContain(loginRequired);
  }
  expect(calls).toHaveLength(0);
});

test.each(everyTool.filter(([tool]) => tool !== "ct_create_appointment"))(
  "a 401 on the read of %s logs out and makes no plan",
  async (tool, args) => {
    const { client } = await ready([
      json({ message: "Session expired!" }, { status: 401 }),
    ]);

    const text = await fails(client, tool, args);
    const status = await ok(client, "ct_status");

    expect(text).toContain(loginRequired);
    expect(text).not.toContain("token");
    expect(status.state).toBe("logged_out");
  },
);

// ct_create_appointment

test("create previews exactly the fields it posts, isInternal false by default, and writes nothing before ct_execute_plan", async () => {
  const { client, calls, requests } = await ready([
    json({ data: sunday }, { status: 201 }),
  ]);

  const p = await plan(client, "ct_create_appointment", {
    ...newAppointment,
    fields: { subtitle: null, repeatId: 0 },
  });

  expect(requests()).toEqual([]);
  expect(p.preview.summary).toBe(
    "Create appointment Harvest festival in calendar 3",
  );
  const body = {
    subtitle: null,
    repeatId: 0,
    calendarId: 3,
    title: "Harvest festival",
    startDate: "2026-10-04T09:00:00Z",
    endDate: "2026-10-04T12:00:00Z",
    isInternal: false,
  };
  expect(p.preview.changes).toEqual([
    {
      method: "POST",
      path: "/calendars/3/appointments",
      fields: Object.fromEntries(
        Object.entries(body).map(([k, after]) => [k, { after }]),
      ),
    },
  ]);

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(requests()).toEqual([`POST ${api}/calendars/3/appointments`]);
  expect(calls[0]?.body).toEqual(body);
});

test("create takes an all-day appointment as YYYY-MM-DD and an internal one", async () => {
  const { client } = await ready([]);

  const p = await plan(client, "ct_create_appointment", {
    ...newAppointment,
    startDate: "2026-10-04",
    endDate: "2026-10-04",
    isInternal: true,
  });

  expect(p.preview.changes[0]?.fields).toMatchObject({
    startDate: { after: "2026-10-04" },
    endDate: { after: "2026-10-04" },
    isInternal: { after: true },
  });
});

test.each([
  { ...newAppointment, title: "  " },
  { ...newAppointment, calendarId: 0 },
  { ...newAppointment, startDate: undefined },
  { ...newAppointment, endDate: undefined },
  { ...newAppointment, startDate: "2026-10-04 09:00" },
  { ...newAppointment, startDate: "2026-10-04T09:00:00+02:00" },
  { ...newAppointment, startDate: "2026-10-04T09:00:00.123Z" },
  { ...newAppointment, endDate: "2026-02-30" },
  { ...newAppointment, isInternal: "no" },
  { ...newAppointment, fields: { calendarId: 4 } },
  { ...newAppointment, fields: { startDate: "tomorrow" } },
])("create rejects %j without a request", async (args) => {
  const { client, calls } = await ready([]);

  await fails(client, "ct_create_appointment", args);

  expect(calls).toHaveLength(0);
});

// ct_update_appointment

test("update previews before and after of the changed fields only and says the whole appointment is sent", async () => {
  const { client, requests } = await ready([json(record(elders))]);

  const p = await plan(client, "ct_update_appointment", {
    calendarId: 3,
    appointmentId: 43,
    title: "Elders meeting (moved)",
    startDate: "2026-10-11T08:00:00Z",
    fields: { link: "https://meet.example.org", description: "With choir" },
  });

  expect(p.preview.summary).toBe("Update appointment 43 (Elders meeting)");
  expect(p.preview.changes).toEqual([
    {
      method: "PUT",
      path: "/calendars/3/appointments/43",
      fields: {
        link: { before: null, after: "https://meet.example.org" },
        title: { before: "Elders meeting", after: "Elders meeting (moved)" },
      },
    },
  ]);
  expect(p.preview.note).toMatch(/whole appointment/);
  expect(p.preview).not.toHaveProperty("warning");
  expect(requests()).toEqual([`GET ${api}/calendars/3/appointments/43`]);
});

test("executing an update re-reads the appointment, then puts the whole stored record with the changes, calendarId and appointmentId", async () => {
  const { client, calls, requests } = await ready([
    json(record(sunday)),
    json(record(sunday)),
    json({ data: { ...sunday, title: "Festive service" } }),
  ]);
  const p = await plan(client, "ct_update_appointment", {
    ...ids,
    title: "Festive service",
    fields: { subtitle: null, link: null, repeatOption: undefined },
  });

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(requests()).toEqual([
    `GET ${sundayPath}`,
    `GET ${sundayPath}`,
    `PUT ${sundayPath}`,
  ]);
  expect(calls[2]?.body).toEqual({
    ...sunday,
    title: "Festive service",
    calendarId: 3,
    appointmentId: 42,
  });
});

test("update sends no deprecated alias field, so an old caption cannot undo the new title", async () => {
  const aliases = {
    caption: "Old",
    information: "With choir",
    note: null,
    additions: [],
    "@deprecated": { caption: "title" },
  };
  const old = { ...sunday, title: "Old", ...aliases };
  const { client, calls } = await ready([
    json(record(old)),
    json(record(old)),
    json({ data: { ...sunday, title: "New" } }),
  ]);
  const p = await plan(client, "ct_update_appointment", {
    ...ids,
    title: "New",
  });

  expect(p.preview.changes[0]?.fields).toEqual({
    title: { before: "Old", after: "New" },
  });
  await ok(client, "ct_execute_plan", { token: p.token });
  expect(calls[2]?.body).toEqual({
    ...sunday,
    title: "New",
    calendarId: 3,
    appointmentId: 42,
  });
});

test("update reads the stored record from appointment.base as in a list item", async () => {
  const { client, calls } = await ready([
    json({ data: occurrence }),
    json({ data: occurrence }),
    json({ data: sunday }),
  ]);
  const p = await plan(client, "ct_update_appointment", {
    ...ids,
    isInternal: true,
  });

  expect(p.preview.changes[0]?.fields).toEqual({
    isInternal: { before: false, after: true },
  });
  await ok(client, "ct_execute_plan", { token: p.token });
  expect(calls[2]?.body).toEqual({
    ...sunday,
    isInternal: true,
    calendarId: 3,
    appointmentId: 42,
  });
});

test("update and delete of a series warn that every occurrence is affected", async () => {
  const { client } = await ready([json(record(sunday)), json(record(sunday))]);

  const update = await plan(client, "ct_update_appointment", {
    ...ids,
    title: "Festive service",
  });
  const remove = await plan(client, "ct_delete_appointment", ids);

  for (const p of [update, remove]) {
    expect(p.preview.warning).toMatch(/whole series/);
    expect(p.preview.warning).toMatch(/single occurrence/);
  }
});

test("delete of a single appointment carries no series warning", async () => {
  const { client } = await ready([json(record(elders))]);

  const p = await plan(client, "ct_delete_appointment", {
    calendarId: 3,
    appointmentId: 43,
  });

  expect(p.preview).not.toHaveProperty("warning");
});

test("an appointment changed since the preview aborts the update with zero writes", async () => {
  const { client, writes } = await ready([
    json(record(sunday)),
    json(record({ ...sunday, version: 4, startDate: "2026-10-11T09:00:00Z" })),
  ]);
  const p = await plan(client, "ct_update_appointment", {
    ...ids,
    title: "Festive service",
  });

  const text = await fails(client, "ct_execute_plan", { token: p.token });

  expect(text).toContain("Nothing was written");
  expect(text).toContain("appointment");
  expect(writes()).toHaveLength(0);
});

test("a re-read without a data envelope aborts the update with zero writes", async () => {
  const { client, writes } = await ready([
    json(record(sunday)),
    json({ appointment: sunday }),
  ]);
  const p = await plan(client, "ct_update_appointment", {
    ...ids,
    title: "Festive service",
  });

  const text = await fails(client, "ct_execute_plan", { token: p.token });

  expect(text).toContain("Nothing was written");
  expect(writes()).toHaveLength(0);
});

test.each([
  [{ appointment: sunday }],
  [{ data: { calculatedDates: {} } }],
  [{ data: { appointment: [] } }],
  [{ data: { appointment: { base: {} } } }],
])(
  "update of an answer %j without a stored appointment is an error and makes no plan",
  async (answer) => {
    const { client } = await ready([json(answer)]);

    const text = await fails(client, "ct_update_appointment", {
      ...ids,
      title: "Festive service",
    });

    expect(text).not.toContain("token");
  },
);

test("an update that changes nothing is a clear error and makes no plan", async () => {
  const { client } = await ready([json(record(sunday))]);

  const text = await fails(client, "ct_update_appointment", {
    ...ids,
    title: "Sunday service",
    fields: { link: null },
  });

  expect(text).toContain("No change");
  expect(text).not.toContain("token");
});

test.each([
  ids,
  { ...ids, fields: {} },
  { ...ids, startDate: "2026-10-11T08:00" },
  { ...ids, endDate: "2026-13-01" },
  { ...ids, title: " " },
  { ...ids, fields: { appointmentId: 7 } },
  { ...ids, fields: { title: "x" } },
])("update rejects %j without a request", async (args) => {
  const { client, calls } = await ready([]);

  await fails(client, "ct_update_appointment", args);

  expect(calls).toHaveLength(0);
});

// ct_delete_appointment

test("delete previews the whole appointment, names it and writes nothing", async () => {
  const { client, requests } = await ready([json(record(sunday))]);

  const p = await plan(client, "ct_delete_appointment", ids);

  expect(p.preview.summary).toBe("Delete appointment 42 (Sunday service)");
  expect(p.preview.changes).toEqual([
    {
      method: "DELETE",
      path: "/calendars/3/appointments/42",
      record: record(sunday).data,
    },
  ]);
  expect(requests()).toEqual([`GET ${sundayPath}`]);
});

test("executing a delete re-reads the appointment, then deletes it without a body", async () => {
  const { client, calls, requests } = await ready([
    json(record(elders)),
    json(record(elders)),
    new Response(null, { status: 204 }),
  ]);
  const p = await plan(client, "ct_delete_appointment", {
    calendarId: 3,
    appointmentId: 43,
  });

  await ok(client, "ct_execute_plan", { token: p.token });

  const path = `${api}/calendars/3/appointments/43`;
  expect(requests()).toEqual([`GET ${path}`, `GET ${path}`, `DELETE ${path}`]);
  expect(calls[2]?.body).toBeUndefined();
});

test("delete of an odd record still plans, names it by id and warns, as the series state is unknown", async () => {
  const { client } = await ready([json({ data: { appointment: [] } })]);

  const p = await plan(client, "ct_delete_appointment", ids);

  expect(p.preview.summary).toBe("Delete appointment 42");
  expect(p.preview.warning).toMatch(/whole series/);
});

test.each([
  ["ct_update_appointment", { title: "x" }],
  ["ct_delete_appointment", {}],
])(
  "%s of an unknown appointment reports the 404 and makes no plan",
  async (tool, args) => {
    const { client } = await ready([
      json({ message: "Appointment not found" }, { status: 404 }),
    ]);

    const text = await fails(client, tool, { ...ids, ...args });

    expect(JSON.parse(text)).toMatchObject({
      error: "Appointment not found",
      status: 404,
    });
  },
);
