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
/** An assignment of a ChurchTools person, as GET /events/{eventId} embeds it. */
const sermon = {
  id: 5,
  serviceId: 30,
  personId: 7,
  person: { title: "Anna Admin", domainIdentifier: "7", domainType: "person" },
  name: "Anna Admin",
  agreed: true,
  isAccepted: true,
  isValid: true,
  comment: "",
  counter: 1,
  index: null,
  allowChat: true,
  event: {
    id: 12,
    name: "Sunday gathering",
    startDate: "2026-10-11T08:00:00Z",
  },
  permissions: null,
  requestedDate: "2026-09-01T10:00:00Z",
  requesterPerson: null,
  requesterPersonId: 7,
  "@deprecated": {},
};
/** A slot nobody fills yet. */
const music = {
  ...sermon,
  id: 6,
  serviceId: 31,
  personId: null,
  person: null,
  name: null,
  agreed: false,
  isAccepted: false,
};
const gathering = {
  id: 12,
  guid: "g-12",
  name: "Sunday gathering",
  description: "",
  startDate: "2026-10-11T08:00:00Z",
  endDate: "2026-10-11T09:30:00Z",
  isCanceled: false,
  note: "Bring chairs",
  adminIds: [7],
  eventAdminIds: [7],
  appointmentId: 42,
  calendar: { title: "Services", domainIdentifier: "3" },
  chatStatus: "NOT_STARTED",
  eventFiles: [],
  permissions: { write: true },
  "@deprecated": {},
  eventServices: [sermon, music],
};
const compactSermon = {
  id: 5,
  serviceId: 30,
  personId: 7,
  name: "Anna Admin",
  isAccepted: true,
  isValid: true,
};
const compactMusic = {
  id: 6,
  serviceId: 31,
  personId: null,
  name: null,
  isAccepted: false,
  isValid: true,
};
const compactGathering = {
  id: 12,
  name: "Sunday gathering",
  startDate: "2026-10-11T08:00:00Z",
  endDate: "2026-10-11T09:30:00Z",
  isCanceled: false,
  eventServices: [compactSermon, compactMusic],
};
const services = [
  { id: 30, name: "Sermon", serviceGroupId: 2, sortKey: 1, groupIds: [] },
  { id: 31, name: "Piano", serviceGroupId: 3, sortKey: 2, groupIds: [] },
];
const serviceGroups = [
  { id: 2, name: "Preaching", sortKey: 1 },
  { id: 3, name: "Music", sortKey: 2 },
];
const event = (data: object = gathering) => json({ data });
const servicesAnswer = () => json({ data: services, meta: { count: 2 } });
const eventPath = `${api}/events/12`;

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

/** The body a preview shows when it has no `before`: every field as `{ after }`. */
function asPreviewFields(body: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(body).map(([k, after]) => [k, { after }]),
  );
}

const query = (path: string) => new URL(path, "https://x").searchParams;

// ct_list_events

test("list events sends one GET /events with from, to, canceled and include=eventServices, without page or limit", async () => {
  const { client, calls, requests } = await ready([json({ data: [] })]);

  await ok(client, "ct_list_events", {
    from: "2026-10-01",
    to: "2026-10-31",
    canceled: true,
  });

  expect(requests()).toEqual([expect.stringMatching(`^GET ${api}/events\\?`)]);
  const sent = query(calls[0]?.path ?? "");
  expect(Object.fromEntries(sent)).toEqual({
    from: "2026-10-01",
    to: "2026-11-01",
    canceled: "true",
    include: "eventServices",
  });
});

test("list events returns per event id, name, dates, canceled state and its compact assignments", async () => {
  const { client } = await ready([
    json({ data: [gathering], meta: { count: 1 } }),
  ]);

  expect(await ok(client, "ct_list_events")).toEqual({
    events: [compactGathering],
  });
});

test.each([[[]], [null], [{}], [undefined]])(
  "list events reads an event whose eventServices are %j and which has no display fields",
  async (eventServices) => {
    const { client } = await ready([
      json({ data: [{ id: 13, eventServices }] }),
    ]);

    expect(await ok(client, "ct_list_events")).toEqual({
      events: [{ id: 13, eventServices: [] }],
    });
  },
);

test("list events reads an assignment whose person is [] and drops one without an id", async () => {
  const odd = { serviceId: 31, name: "Ghost" };
  const external = { id: 8, person: [], name: "Guest speaker", agreed: true };
  const { client } = await ready([
    json({ data: [{ id: 13, eventServices: [odd, external, sermon] }] }),
  ]);

  expect(await ok(client, "ct_list_events")).toEqual({
    events: [
      {
        id: 13,
        eventServices: [
          { id: 8, name: "Guest speaker", isAccepted: true },
          compactSermon,
        ],
      },
    ],
  });
});

test("list events takes one day as from and to; ChurchTools leaves out its to day, so it gets the next day", async () => {
  const { client, calls } = await ready([json({ data: [] })]);

  await ok(client, "ct_list_events", { from: "2026-10-11", to: "2026-10-11" });

  expect(query(calls[0]?.path ?? "").get("to")).toBe("2026-10-12");
});

test.each([
  ["2026-12-31", "2027-01-01"],
  ["2028-02-28", "2028-02-29"],
  ["2026-03-28", "2026-03-29"],
])("list events sends the day after %s as to", async (to, sent) => {
  const { client, calls } = await ready([json({ data: [] })]);

  await ok(client, "ct_list_events", { to });

  expect(query(calls[0]?.path ?? "").get("to")).toBe(sent);
});

test.each([
  { from: "2026-02-30" },
  { from: "11.10.2026" },
  { to: "2026-10-11T00:00:00Z" },
  { from: "2026-10-11", to: "2026-10-01" },
  { canceled: "yes" },
])("list events rejects %j without a request", async (args) => {
  const { client, calls } = await ready([]);

  await fails(client, "ct_list_events", args);

  expect(calls).toHaveLength(0);
});

// ct_get_event

test("get event reads the event and the service names and shows each assignment with its service name", async () => {
  const { client, requests } = await ready([event(), servicesAnswer()]);

  const result = await ok(client, "ct_get_event", { eventId: 12 });

  expect(result).toEqual({
    ...gathering,
    eventServices: [
      { ...compactSermon, serviceName: "Sermon" },
      { ...compactMusic, serviceName: "Piano" },
    ],
  });
  expect(requests()).toEqual([`GET ${eventPath}`, `GET ${api}/services`]);
});

test("get of an unknown event reports the server's message, not the raw body", async () => {
  const { client } = await ready([
    new Response(`<html>${cookieValue}</html>`, { status: 404 }),
    json({ message: "Event not found" }, { status: 404 }),
  ]);

  expect(await fails(client, "ct_get_event", { eventId: 99 })).toContain(
    "HTTP 404",
  );
  expect(await fails(client, "ct_get_event", { eventId: 99 })).toContain(
    "Event not found",
  );
});

// ct_list_services

test("list services reads GET /services and /servicegroups and names each service's group", async () => {
  const { client, requests } = await ready([
    servicesAnswer(),
    json({ data: serviceGroups }),
  ]);

  expect(await ok(client, "ct_list_services")).toEqual({
    services: [
      {
        id: 30,
        name: "Sermon",
        serviceGroupId: 2,
        serviceGroupName: "Preaching",
      },
      { id: 31, name: "Piano", serviceGroupId: 3, serviceGroupName: "Music" },
    ],
  });
  expect(requests()).toEqual([
    `GET ${api}/services`,
    `GET ${api}/servicegroups`,
  ]);
});

test("list services still lists the services when /servicegroups fails, and says the group names are missing", async () => {
  const { client } = await ready([
    servicesAnswer(),
    json({ message: "Internal error" }, { status: 500 }),
  ]);

  expect(await ok(client, "ct_list_services")).toEqual({
    services: [
      { id: 30, name: "Sermon", serviceGroupId: 2 },
      { id: 31, name: "Piano", serviceGroupId: 3 },
    ],
    serviceGroupNames: "not read: Internal error",
  });
});

test("list services reads a service without name or group", async () => {
  const { client } = await ready([
    json({ data: [{ id: 32 }, { id: 33, serviceGroupId: 9 }] }),
    json({ data: [] }),
  ]);

  expect(await ok(client, "ct_list_services")).toEqual({
    services: [{ id: 32 }, { id: 33, serviceGroupId: 9 }],
  });
});

// Ids

const badIds = [0, -1, 1.5, "12", null];
const ids = { eventId: 12, eventServiceId: 6 };
const idTools: [string, string[], Record<string, unknown>][] = [
  ["ct_get_event", ["eventId"], {}],
  ["ct_update_event", ["eventId"], { isCanceled: true }],
  ["ct_delete_event", ["eventId"], {}],
  [
    "ct_assign_event_service",
    ["eventId", "eventServiceId", "personId"],
    { personId: 7 },
  ],
  [
    "ct_set_external_event_service",
    ["eventId", "eventServiceId"],
    { name: "Guest speaker" },
  ],
];

test.each(
  idTools.flatMap(([tool, keys, args]) =>
    keys.flatMap((key) => badIds.map((id) => [tool, key, args, id])),
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

const everyTool: [string, Record<string, unknown>][] = [
  ["ct_list_events", {}],
  ["ct_get_event", { eventId: 12 }],
  ["ct_list_services", {}],
  ["ct_update_event", { eventId: 12, isCanceled: true }],
  ["ct_delete_event", { eventId: 12 }],
  ["ct_assign_event_service", { ...ids, personId: 7 }],
  ["ct_set_external_event_service", { ...ids, name: "Guest speaker" }],
];

test("without a login every event tool asks for the 2FA code and sends nothing", async () => {
  const { fetch, calls } = fakeFetch();
  const client = await connectClient(fetch);

  for (const [tool, args] of everyTool) {
    expect(await fails(client, tool, args)).toContain(loginRequired);
  }
  expect(calls).toHaveLength(0);
});

test.each(everyTool)(
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

// ct_update_event

test("update event previews before and after of the changed fields only, names the event and writes nothing", async () => {
  const { client, requests } = await ready([event()]);

  const p = await plan(client, "ct_update_event", {
    eventId: 12,
    isCanceled: true,
    note: "Bring chairs",
    adminIds: [7, 9],
  });

  expect(p.preview.summary).toBe(
    "Update event 12 (Sunday gathering on 2026-10-11T08:00:00Z)",
  );
  expect(p.preview.changes).toEqual([
    {
      method: "PUT",
      path: "/events/12",
      fields: {
        adminIds: { before: [7], after: [7, 9] },
        isCanceled: { before: false, after: true },
      },
    },
  ]);
  expect(requests()).toEqual([`GET ${eventPath}`]);
});

test("executing an event update re-reads the event, then puts exactly the previewed fields", async () => {
  const { client, calls, requests } = await ready([
    event(),
    event(),
    event({ ...gathering, note: null }),
  ]);
  const p = await plan(client, "ct_update_event", { eventId: 12, note: null });

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(requests()).toEqual([
    `GET ${eventPath}`,
    `GET ${eventPath}`,
    `PUT ${eventPath}`,
  ]);
  expect(calls[2]?.body).toEqual({ note: null });
  expect(p.preview.changes[0]?.fields).toEqual({
    note: { before: "Bring chairs", after: null },
  });
});

test("an event whose assignments changed since the preview aborts the update with zero writes", async () => {
  const { client, writes } = await ready([
    event(),
    event({ ...gathering, eventServices: [sermon, { ...music, personId: 9 }] }),
  ]);
  const p = await plan(client, "ct_update_event", {
    eventId: 12,
    isCanceled: true,
  });

  const text = await fails(client, "ct_execute_plan", { token: p.token });

  expect(text).toContain("Nothing was written");
  expect(text).toContain("eventServices");
  expect(writes()).toHaveLength(0);
});

test("an event update that changes nothing is a clear error and makes no plan", async () => {
  const { client } = await ready([event()]);

  const text = await fails(client, "ct_update_event", {
    eventId: 12,
    isCanceled: false,
    adminIds: [7],
  });

  expect(text).toContain("No change");
  expect(text).toContain("Sunday gathering");
  expect(text).not.toContain("token");
});

test("update event names a field it does not take, as PUT takes only isCanceled, note and adminIds", async () => {
  const { client } = await ready([]);

  const text = await fails(client, "ct_update_event", {
    eventId: 12,
    name: "Renamed",
  });

  expect(text).toContain('Unrecognized key: "name"');
});

test.each([
  { eventId: 12 },
  { eventId: 12, name: "Renamed" },
  { eventId: 12, isCanceled: true, startDate: "2026-10-12T08:00:00Z" },
  { eventId: 12, note: "x", eventServices: [] },
  { eventId: 12, fields: { name: "x" } },
  { eventId: 12, isCanceled: "yes" },
  { eventId: 12, note: "x".repeat(4001) },
  { eventId: 12, adminIds: [0] },
  { eventId: 12, adminIds: 7 },
])("update event rejects %j without a request", async (args) => {
  const { client, calls } = await ready([]);

  await fails(client, "ct_update_event", args);

  expect(calls).toHaveLength(0);
});

// ct_delete_event

test("delete event previews the whole event with sendMail false, names it and writes nothing", async () => {
  const { client, requests } = await ready([event()]);

  const p = await plan(client, "ct_delete_event", { eventId: 12 });

  expect(p.preview.summary).toBe(
    "Delete event 12 (Sunday gathering on 2026-10-11T08:00:00Z)",
  );
  expect(p.preview.changes).toEqual([
    {
      method: "DELETE",
      path: "/events/12",
      query: { sendMail: false },
      record: gathering,
    },
  ]);
  expect(requests()).toEqual([`GET ${eventPath}`]);
});

test("executing an event delete re-reads the event, then deletes it with sendMail=false and no body", async () => {
  const { client, calls, requests } = await ready([
    event(),
    event(),
    new Response(null, { status: 204 }),
  ]);
  const p = await plan(client, "ct_delete_event", { eventId: 12 });

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(requests()).toEqual([
    `GET ${eventPath}`,
    `GET ${eventPath}`,
    `DELETE ${eventPath}?sendMail=false`,
  ]);
  expect(calls[2]?.body).toBeUndefined();
});

test("delete event with sendMail sends it and says so in the summary", async () => {
  const { client, requests } = await ready([
    event(),
    event(),
    new Response(null, { status: 204 }),
  ]);
  const p = await plan(client, "ct_delete_event", {
    eventId: 12,
    sendMail: true,
  });

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(p.preview.summary).toMatch(/email/);
  expect(requests()[2]).toBe(`DELETE ${eventPath}?sendMail=true`);
});

test("delete of an event without a name still plans and names it by id", async () => {
  const { client } = await ready([event({ id: 12, eventServices: [] })]);

  const p = await plan(client, "ct_delete_event", { eventId: 12 });

  expect(p.preview.summary).toBe("Delete event 12");
});

test.each([
  ["ct_update_event", { isCanceled: true }],
  ["ct_delete_event", {}],
  ["ct_assign_event_service", { eventServiceId: 6, personId: 7 }],
  ["ct_set_external_event_service", { eventServiceId: 6, name: "Guest" }],
])(
  "%s of an unknown event reports the 404 and makes no plan",
  async (tool, args) => {
    const { client } = await ready([
      json({ message: "Event not found" }, { status: 404 }),
    ]);

    const text = await fails(client, tool, { eventId: 99, ...args });

    expect(JSON.parse(text)).toMatchObject({
      error: "Event not found",
      status: 404,
    });
  },
);

// ct_assign_event_service

test("assign previews exactly the body it puts, isAccepted false by default, with service name and current assignee", async () => {
  const { client, requests } = await ready([event(), servicesAnswer()]);

  const p = await plan(client, "ct_assign_event_service", {
    ...ids,
    personId: 7,
  });

  expect(p.preview.summary).toBe(
    "Assign person 7 to Piano (assignment 6) of event 12 (Sunday gathering on 2026-10-11T08:00:00Z)",
  );
  expect(p.preview.changes).toEqual([
    {
      method: "PUT",
      path: "/events/12/servicerequests/6",
      fields: asPreviewFields({ personId: 7, isAccepted: false }),
    },
  ]);
  expect(p.preview.currentAssignment).toEqual({
    ...compactMusic,
    serviceName: "Piano",
  });
  expect(requests()).toEqual([`GET ${eventPath}`, `GET ${api}/services`]);
});

test("executing an assignment re-reads the event, then puts the previewed body to the service request", async () => {
  const { client, calls, requests } = await ready([
    event(),
    servicesAnswer(),
    event(),
    json({ data: { ...sermon, id: 15 } }),
  ]);
  const args = {
    eventId: 12,
    eventServiceId: 5,
    name: "  Guest speaker ",
    isAccepted: true,
    comment: "Confirmed by phone",
  };
  const p = await plan(client, "ct_assign_event_service", args);

  await ok(client, "ct_execute_plan", { token: p.token });

  const body = {
    name: "Guest speaker",
    isAccepted: true,
    comment: "Confirmed by phone",
  };
  expect(requests().slice(2)).toEqual([
    `GET ${eventPath}`,
    `PUT ${eventPath}/servicerequests/5`,
  ]);
  expect(calls[3]?.body).toEqual(body);
  expect(p.preview.changes[0]?.fields).toEqual(asPreviewFields(body));
  expect(p.preview.summary).toMatch(/^Assign Guest speaker to Sermon/);
  expect(p.preview.currentAssignment).toEqual({
    ...compactSermon,
    serviceName: "Sermon",
  });
});

test.each([
  { ...ids },
  { ...ids, personId: 7, name: "Guest speaker" },
  { ...ids, personId: 7, name: null },
  { ...ids, name: "G" },
  { ...ids, name: "  G  " },
  { ...ids, name: "x".repeat(256) },
  { ...ids, personId: 7, comment: "x".repeat(256) },
  { ...ids, personId: 7, isAccepted: "yes" },
])("assign rejects %j without a request", async (args) => {
  const { client, calls } = await ready([]);

  await fails(client, "ct_assign_event_service", args);

  expect(calls).toHaveLength(0);
});

test.each([{ personId: 7, name: "Guest speaker" }, {}])(
  "assign with %j says to give exactly one of personId and name",
  async (assignee) => {
    const { client } = await ready([]);

    const text = await fails(client, "ct_assign_event_service", {
      ...ids,
      ...assignee,
    });

    expect(text).toContain("exactly one of personId and name");
  },
);

test.each([
  ["ct_assign_event_service", { personId: 7 }],
  ["ct_set_external_event_service", { name: "Guest speaker" }],
])(
  "%s of an assignment the event does not have is a clear error and makes no plan",
  async (tool, args) => {
    const { client, requests } = await ready([event(), servicesAnswer()]);

    const text = await fails(client, tool, {
      eventId: 12,
      eventServiceId: 99,
      ...args,
    });

    expect(text).toContain("no service assignment 99");
    expect(text).toContain("5, 6");
    expect(text).not.toContain("token");
    expect(requests()).toEqual([`GET ${eventPath}`]);
  },
);

test.each([
  ["ct_assign_event_service", { personId: 7 }],
  ["ct_set_external_event_service", { name: "Guest speaker" }],
])(
  "%s aborts with zero writes when the assignment changed since the preview",
  async (tool, args) => {
    const { client, writes } = await ready([
      event(),
      servicesAnswer(),
      event({
        ...gathering,
        eventServices: [sermon, { ...music, personId: 9 }],
      }),
    ]);
    const p = await plan(client, tool, { ...ids, ...args });

    const text = await fails(client, "ct_execute_plan", { token: p.token });

    expect(text).toContain("Nothing was written");
    expect(writes()).toHaveLength(0);
  },
);

// ct_set_external_event_service

test("set external helper previews exactly the body it puts, with eventId, eventServiceId and agreed false by default", async () => {
  const { client, calls, requests, writes } = await ready([
    event(),
    servicesAnswer(),
    event(),
    new Response(null, { status: 204 }),
  ]);

  const p = await plan(client, "ct_set_external_event_service", {
    ...ids,
    name: " Guest speaker ",
  });

  const body = {
    eventId: 12,
    eventServiceId: 6,
    name: "Guest speaker",
    agreed: false,
  };
  expect(p.preview.summary).toBe(
    "Set external helper Guest speaker for Piano (assignment 6) of event 12 (Sunday gathering on 2026-10-11T08:00:00Z)",
  );
  expect(p.preview.changes).toEqual([
    {
      method: "PUT",
      path: "/events/12/eventservices/6",
      fields: asPreviewFields(body),
    },
  ]);
  expect(p.preview.currentAssignment).toEqual({
    ...compactMusic,
    serviceName: "Piano",
  });
  expect(writes()).toHaveLength(0);

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(requests().slice(2)).toEqual([
    `GET ${eventPath}`,
    `PUT ${eventPath}/eventservices/6`,
  ]);
  expect(calls[3]?.body).toEqual(body);
});

test("set external helper sends agreed and a comment when given", async () => {
  const { client } = await ready([event(), servicesAnswer()]);

  const p = await plan(client, "ct_set_external_event_service", {
    ...ids,
    name: "Guest speaker",
    agreed: true,
    comment: "Brings own guitar",
  });

  expect(p.preview.changes[0]?.fields).toEqual(
    asPreviewFields({
      eventId: 12,
      eventServiceId: 6,
      name: "Guest speaker",
      agreed: true,
      comment: "Brings own guitar",
    }),
  );
});

test.each([
  { ...ids },
  { ...ids, name: "G" },
  { ...ids, name: "   " },
  { ...ids, name: "x".repeat(256) },
  { ...ids, name: "Guest", agreed: "yes" },
  { ...ids, name: "Guest", comment: "x".repeat(256) },
  { ...ids, name: "Guest", comment: null },
  { ...ids, name: "Guest", personId: 7 },
])("set external helper rejects %j without a request", async (args) => {
  const { client, calls } = await ready([]);

  await fails(client, "ct_set_external_event_service", args);

  expect(calls).toHaveLength(0);
});

test("assign names a service that /services does not list by its id", async () => {
  const { client } = await ready([event(), json({ data: [] })]);

  const p = await plan(client, "ct_assign_event_service", {
    ...ids,
    personId: 7,
  });

  expect(p.preview.summary).toMatch(
    /^Assign person 7 to service 31 \(assignment 6\)/,
  );
  expect(p.preview.currentAssignment).toEqual(compactMusic);
});

test.each([
  [403, json({ message: "Forbidden" }, { status: 403 }), "Forbidden"],
  [500, new Response("oops", { status: 500 }), "HTTP 500"],
])(
  "a %i on /services leaves get event working with the reason as service name",
  async (_status, answer, reason) => {
    const { client } = await ready([event(), answer]);

    const result = await ok(client, "ct_get_event", { eventId: 12 });

    expect(result.eventServices).toEqual([
      { ...compactSermon, serviceName: `(unknown: ${reason})` },
      { ...compactMusic, serviceName: `(unknown: ${reason})` },
    ]);
  },
);

test.each([
  ["ct_assign_event_service", { personId: 7 }],
  ["ct_set_external_event_service", { name: "Guest speaker" }],
])(
  "%s still plans after a 403 on /services and shows the reason as service name",
  async (tool, args) => {
    const { client } = await ready([
      event(),
      json({ message: "Forbidden" }, { status: 403 }),
    ]);

    const p = await plan(client, tool, { ...ids, ...args });

    expect(p.preview.currentAssignment).toEqual({
      ...compactMusic,
      serviceName: "(unknown: Forbidden)",
    });
  },
);

test.each([
  ["ct_get_event", { eventId: 12 }],
  ["ct_assign_event_service", { ...ids, personId: 7 }],
])(
  "%s with a 401 on /services logs out and makes no plan",
  async (tool, args) => {
    const { client } = await ready([
      event(),
      json({ message: "Session expired!" }, { status: 401 }),
    ]);

    const text = await fails(client, tool, args);

    expect(text).toContain(loginRequired);
    expect(text).not.toContain("token");
  },
);
