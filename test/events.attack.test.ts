import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, test } from "vitest";
import { createServer } from "../src/server.js";
import {
  code,
  env,
  fakeFetch,
  json,
  loginAnswers,
  secrets,
} from "./fake-fetch.js";

const api = "/churchtools/api";
const eventPath = `${api}/events/12`;
/** An accepted assignment of a ChurchTools person, in production shape. */
const sermon = {
  id: 5,
  serviceId: 30,
  personId: 7,
  person: {
    title: "Zoë Ørsted",
    domainIdentifier: "7",
    domainType: "person",
    apiUrl: "https://example.org/api/persons/7",
  },
  name: "Zoë Ørsted",
  agreed: true,
  isAccepted: true,
  isValid: true,
  comment: "",
  counter: 1,
  index: null,
  allowChat: true,
  event: { id: 12, name: "Gottesdienst", startDate: "2026-10-11T08:00:00Z" },
  permissions: null,
  requestedDate: "2026-09-01T10:00:00Z",
  requesterPerson: null,
  requesterPersonId: 7,
  "@deprecated": {},
};
/** An open slot. */
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
  name: "Gottesdienst – Erntedank",
  description: "",
  startDate: "2026-10-11T08:00:00Z",
  endDate: "2026-10-11T09:30:00Z",
  isCanceled: false,
  note: "Stühle mitbringen",
  adminIds: [7],
  eventAdminIds: [7],
  appointmentId: 42,
  calendar: { title: "Gottesdienste", domainIdentifier: "3" },
  chatStatus: "NOT_STARTED",
  eventFiles: [],
  permissions: { write: true },
  "@deprecated": {},
  eventServices: [sermon, music],
};
const services = [
  { id: 30, name: "Predigt", serviceGroupId: 2 },
  { id: 31, name: "Klavier", serviceGroupId: 3 },
];
const event = (data: object = gathering) => json({ data });
const servicesAnswer = () => json({ data: services });
const ids = { eventId: 12, eventServiceId: 6 };

async function connectClient(fetch: typeof globalThis.fetch) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await createServer({ env, fetch }).connect(serverTransport);
  const client = new Client({ name: "attack-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

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
    currentAssignment?: Record<string, unknown>;
  };
}

async function plan(client: Client, name: string, args: unknown) {
  return (await ok(client, name, args)) as unknown as Plan;
}

/** The fields a preview shows for a write without `before`. */
const afterOnly = (body: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(body).map(([k, v]) => [k, { after: v }]));

// Odd event shapes on the single-event tools

test.each([[null], [[]], [undefined], ["none"]])(
  "get event with eventServices %j shows the event with an empty list",
  async (eventServices) => {
    const { client, requests } = await ready([
      event({ ...gathering, eventServices }),
      servicesAnswer(),
    ]);

    const result = await ok(client, "ct_get_event", { eventId: 12 });

    expect(result.eventServices).toEqual([]);
    expect(result.note).toBe("Stühle mitbringen");
    expect(requests()[0]).toBe(`GET ${eventPath}`);
  },
);

test("get event reads assignments without a person key, with a null person title and with only agreed", async () => {
  const noPerson = { id: 20, serviceId: 30, personId: null, name: null };
  const titleless = {
    id: 21,
    serviceId: 31,
    personId: null,
    person: { title: null },
    name: "Gast aus Ulm",
    agreed: true,
  };
  const acceptedOverAgreed = {
    id: 22,
    serviceId: 30,
    personId: 8,
    person: { title: "Ben" },
    isAccepted: false,
    agreed: true,
  };
  const { client } = await ready([
    event({
      ...gathering,
      eventServices: [noPerson, titleless, acceptedOverAgreed],
    }),
    servicesAnswer(),
  ]);

  const result = await ok(client, "ct_get_event", { eventId: 12 });

  expect(result.eventServices).toEqual([
    {
      id: 20,
      serviceId: 30,
      personId: null,
      name: null,
      serviceName: "Predigt",
    },
    {
      id: 21,
      serviceId: 31,
      personId: null,
      name: "Gast aus Ulm",
      isAccepted: true,
      serviceName: "Klavier",
    },
    {
      id: 22,
      serviceId: 30,
      personId: 8,
      name: "Ben",
      isAccepted: false,
      serviceName: "Predigt",
    },
  ]);
});

test("assign to an event whose eventServices are null says it has none and makes no plan", async () => {
  const { client } = await ready([
    event({ ...gathering, eventServices: null }),
  ]);

  const text = await fails(client, "ct_assign_event_service", {
    ...ids,
    personId: 7,
  });

  expect(text).toContain("no service assignment 6");
  expect(text).toContain("ids are none");
  expect(text).not.toContain("token");
});

test("assign to an assignment without serviceId names it as an unknown service", async () => {
  const { client } = await ready([
    event({ ...gathering, eventServices: [{ ...music, serviceId: null }] }),
    servicesAnswer(),
  ]);

  const p = await plan(client, "ct_assign_event_service", {
    ...ids,
    personId: 7,
  });

  expect(p.preview.summary).toBe(
    "Assign person 7 to service unknown (assignment 6) of event 12 (Gottesdienst – Erntedank on 2026-10-11T08:00:00Z)",
  );
});

// An eventServiceId that is not this event's

test.each([
  ["the id of another event's assignment", 77],
  ["the serviceId instead of the assignment id", 30],
])(
  "assign with %s reads only this event and makes no plan",
  async (_case, eventServiceId) => {
    const { client, requests, writes } = await ready([event()]);

    const text = await fails(client, "ct_assign_event_service", {
      eventId: 12,
      eventServiceId,
      personId: 7,
    });

    expect(text).toContain(`no service assignment ${eventServiceId}`);
    expect(text).toContain("5, 6");
    expect(requests()).toEqual([`GET ${eventPath}`]);
    expect(writes()).toHaveLength(0);
  },
);

// A slot that is already taken or accepted

test("assign another person to an accepted slot previews who holds it now and what replaces it", async () => {
  const { client } = await ready([event(), servicesAnswer()]);

  const p = await plan(client, "ct_assign_event_service", {
    eventId: 12,
    eventServiceId: 5,
    personId: 9,
  });

  expect(p.preview.summary).toMatch(
    /^Assign person 9 to Predigt \(assignment 5\)/,
  );
  expect(p.preview.currentAssignment).toEqual({
    id: 5,
    serviceId: 30,
    personId: 7,
    name: "Zoë Ørsted",
    isAccepted: true,
    isValid: true,
    serviceName: "Predigt",
  });
  expect(p.preview.changes[0]?.fields).toEqual(
    afterOnly({ personId: 9, isAccepted: false }),
  );
});

test("assign to a superseded assignment still shows isValid false in the preview", async () => {
  const { client } = await ready([
    event({ ...gathering, eventServices: [{ ...sermon, isValid: false }] }),
    servicesAnswer(),
  ]);

  const p = await plan(client, "ct_assign_event_service", {
    eventId: 12,
    eventServiceId: 5,
    personId: 9,
  });

  expect(p.preview.currentAssignment?.isValid).toBe(false);
});

// personId and name

test.each([
  { ...ids, personId: 7, name: "" },
  { ...ids, name: 42 },
  { ...ids, personId: "7" },
  { ...ids, personId: 7, eventId: undefined },
  { ...ids, personId: 7, agreed: true },
])("assign rejects %j without a request", async (args) => {
  const { client, calls } = await ready([]);

  await fails(client, "ct_assign_event_service", args);

  expect(calls).toHaveLength(0);
});

test("executing an assignment of a person puts exactly the previewed personId, isAccepted and comment", async () => {
  const { client, calls, requests } = await ready([
    event(),
    servicesAnswer(),
    event(),
    json({ data: { ...music, personId: 7 } }),
  ]);
  const p = await plan(client, "ct_assign_event_service", {
    ...ids,
    personId: 7,
    isAccepted: true,
    comment: "",
  });

  await ok(client, "ct_execute_plan", { token: p.token });

  const body = { personId: 7, isAccepted: true, comment: "" };
  expect(p.preview.changes[0]?.fields).toEqual(afterOnly(body));
  expect(requests().slice(2)).toEqual([
    `GET ${eventPath}`,
    `PUT ${eventPath}/servicerequests/6`,
  ]);
  expect(calls[3]?.body).toEqual(body);
});

// ct_update_event: cancel, then un-cancel

test("cancel then un-cancel: each plan previews and puts only isCanceled", async () => {
  const canceled = { ...gathering, isCanceled: true };
  const { client, calls, requests } = await ready([
    event(),
    event(),
    event(canceled),
    event(canceled),
    event(canceled),
    event(),
  ]);

  const cancel = await plan(client, "ct_update_event", {
    eventId: 12,
    isCanceled: true,
  });
  await ok(client, "ct_execute_plan", { token: cancel.token });
  const undo = await plan(client, "ct_update_event", {
    eventId: 12,
    isCanceled: false,
  });
  await ok(client, "ct_execute_plan", { token: undo.token });

  expect(undo.preview.changes[0]?.fields).toEqual({
    isCanceled: { before: true, after: false },
  });
  expect(requests().filter((r) => r.startsWith("PUT"))).toEqual([
    `PUT ${eventPath}`,
    `PUT ${eventPath}`,
  ]);
  const puts = calls.filter((c) => c.method === "PUT").map((c) => c.body);
  expect(puts).toEqual([{ isCanceled: true }, { isCanceled: false }]);
});

test("cancel of an already canceled event is a clear no-change error", async () => {
  const { client, writes } = await ready([
    event({ ...gathering, isCanceled: true }),
  ]);

  const text = await fails(client, "ct_update_event", {
    eventId: 12,
    isCanceled: true,
  });

  expect(text).toContain("No change");
  expect(writes()).toHaveLength(0);
});

test("update clearing all admins previews [7] to [] and puts adminIds []", async () => {
  const { client, calls } = await ready([event(), event(), event()]);

  const p = await plan(client, "ct_update_event", {
    eventId: 12,
    adminIds: [],
    note: "Erntedank 🌾 – bitte Körbe",
  });
  await ok(client, "ct_execute_plan", { token: p.token });

  expect(p.preview.changes[0]?.fields).toEqual({
    adminIds: { before: [7], after: [] },
    note: { before: "Stühle mitbringen", after: "Erntedank 🌾 – bitte Körbe" },
  });
  expect(calls[2]?.body).toEqual({
    adminIds: [],
    note: "Erntedank 🌾 – bitte Körbe",
  });
});

// ct_delete_event

test("delete of a canceled event previews the canceled record and deletes it", async () => {
  const canceled = { ...gathering, isCanceled: true };
  const { client, requests } = await ready([
    event(canceled),
    event(canceled),
    new Response(null, { status: 204 }),
  ]);

  const p = await plan(client, "ct_delete_event", { eventId: 12 });
  await ok(client, "ct_execute_plan", { token: p.token });

  expect(p.preview.changes[0]?.record).toEqual(canceled);
  expect(requests()[2]).toBe(`DELETE ${eventPath}?sendMail=false`);
});

test("delete of an event that vanished after the preview writes nothing", async () => {
  const { client, writes } = await ready([
    event(),
    json({ message: "Event not found" }, { status: 404 }),
  ]);

  const p = await plan(client, "ct_delete_event", { eventId: 12 });
  const text = await fails(client, "ct_execute_plan", { token: p.token });

  expect(text).toContain("Nothing was written");
  expect(text).toContain("no longer exists");
  expect(writes()).toHaveLength(0);
});

test("delete aborts with zero writes when a service was reassigned after the preview", async () => {
  const { client, writes } = await ready([
    event(),
    event({ ...gathering, eventServices: [{ ...sermon, personId: 9 }, music] }),
  ]);

  const p = await plan(client, "ct_delete_event", { eventId: 12 });
  const text = await fails(client, "ct_execute_plan", { token: p.token });

  expect(text).toContain("eventServices");
  expect(writes()).toHaveLength(0);
});

test.each(["false", "true", 0, 1, null, "yes"])(
  "delete rejects sendMail %j without a request",
  async (sendMail) => {
    const { client, calls } = await ready([]);

    await fails(client, "ct_delete_event", { eventId: 12, sendMail });

    expect(calls).toHaveLength(0);
  },
);

test("delete with sendMail true previews the same query it sends", async () => {
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

  expect(p.preview.changes[0]?.query).toEqual({ sendMail: true });
  expect(requests()[2]).toBe(`DELETE ${eventPath}?sendMail=true`);
});

// Guard: two plans race for one slot

test("of two plans for one open slot, the second aborts after the first filled it", async () => {
  const filled = {
    ...gathering,
    eventServices: [sermon, { ...music, personId: 7, name: "Zoë Ørsted" }],
  };
  const { client, writes } = await ready([
    event(),
    servicesAnswer(),
    event(),
    servicesAnswer(),
    event(),
    json({ data: filled.eventServices[1] }),
    event(filled),
  ]);

  const first = await plan(client, "ct_assign_event_service", {
    ...ids,
    personId: 7,
  });
  const second = await plan(client, "ct_set_external_event_service", {
    ...ids,
    name: "Gast aus Ulm",
  });
  await ok(client, "ct_execute_plan", { token: first.token });
  const text = await fails(client, "ct_execute_plan", { token: second.token });

  expect(text).toContain("Nothing was written");
  expect(writes()).toHaveLength(1);
});

// ct_set_external_event_service

test('set external helper with an empty comment previews and sends comment ""', async () => {
  const { client, calls } = await ready([
    event(),
    servicesAnswer(),
    event(),
    new Response(null, { status: 204 }),
  ]);

  const p = await plan(client, "ct_set_external_event_service", {
    ...ids,
    name: "Gast aus Ulm",
    agreed: true,
    comment: "",
  });
  await ok(client, "ct_execute_plan", { token: p.token });

  const body = {
    eventId: 12,
    eventServiceId: 6,
    name: "Gast aus Ulm",
    agreed: true,
    comment: "",
  };
  expect(p.preview.changes[0]?.fields).toEqual(afterOnly(body));
  expect(calls[3]?.body).toEqual(body);
});

// ct_list_events with a large range

test("list events over eleven years returns every event of the one answer", async () => {
  const many = Array.from({ length: 1500 }, (_, i) => ({
    id: i + 1,
    name: `Event ${i + 1}`,
    startDate: "2026-10-11T08:00:00Z",
    eventServices: [sermon],
  }));
  const { client, requests } = await ready([json({ data: many })]);

  const result = await ok(client, "ct_list_events", {
    from: "2020-01-01",
    to: "2030-12-31",
  });

  expect(requests()).toHaveLength(1);
  expect(result.events).toHaveLength(1500);
});
