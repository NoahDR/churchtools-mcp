import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, test } from "vitest";
import { createServer } from "../src/server.js";
import {
  code,
  cookieValue,
  csrfToken,
  env,
  fakeFetch,
  json,
  loginAnswers,
  secrets,
} from "./fake-fetch.js";

const api = "/churchtools/api";
const calendar = { id: 3, name: "Gottesdienste", isPublic: true };
/** A single timed appointment in production shape: nulls, nested objects, unicode. */
const timed = {
  id: 42,
  title: "Gemeindeversammlung – Zoë & Ørsted",
  subtitle: null,
  description: "",
  link: null,
  isInternal: false,
  allDay: false,
  startDate: "2026-10-11T08:00:00Z",
  endDate: "2026-10-11T09:30:00Z",
  repeatId: 0,
  repeatFrequency: null,
  repeatUntil: null,
  repeatOption: null,
  exceptions: [],
  additionals: [],
  address: null,
  calendar,
  meta: { modifiedDate: "2026-09-01T10:00:00Z" },
};
/** The same appointment stored as all-day. */
const allDay = {
  ...timed,
  allDay: true,
  startDate: "2026-10-11",
  endDate: "2026-10-11",
};
const record = (base: unknown) => ({
  data: { appointment: base, calculatedDates: {}, additionalInfos: [] },
});
const ids = { calendarId: 3, appointmentId: 42 };
const path = `${api}/calendars/3/appointments/42`;
const notFound = () =>
  json({ message: "Appointment not found" }, { status: 404 });

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
    changes: {
      fields?: Record<string, { before?: unknown; after: unknown }>;
      record?: unknown;
      [key: string]: unknown;
    }[];
    [key: string]: unknown;
  };
}

async function plan(client: Client, name: string, args: unknown) {
  return (await ok(client, name, args)) as unknown as Plan;
}

const query = (p: string) => new URL(p, "https://x").searchParams;
/** A copy of `record` without `key`. */
const without = (record: object, key: string) =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));

// ct_list_appointments: odd shapes

test.each([
  ["calendar null", { calendar: null }, {}],
  ["calendar missing", {}, {}],
  ["calendar id as text", { calendar: { id: "3" } }, {}],
  ["repeatId null", { calendar, repeatId: null }, { calendarId: 3 }],
])(
  "list appointments reads an occurrence with %s and keeps the rest",
  async (_name, base, expected) => {
    const { client } = await ready([
      json({
        data: [
          {
            appointment: {
              base: { id: 9, title: "Taufe", ...base },
              calculated: {
                startDate: "2026-10-11",
                endDate: "2026-10-11",
              },
            },
          },
        ],
      }),
    ]);

    const result = await ok(client, "ct_list_appointments", {
      calendar_ids: [3],
    });

    expect(result.appointments).toEqual([
      {
        id: 9,
        title: "Taufe",
        startDate: "2026-10-11",
        endDate: "2026-10-11",
        ...expected,
        ...("repeatId" in base && { repeatId: base.repeatId }),
      },
    ]);
  },
);

test.each([null, [], "x"])(
  "list appointments reads an occurrence whose calculated is %j",
  async (calculated) => {
    const { client } = await ready([
      json({ data: [{ base: { id: 9, calendar }, calculated }] }),
    ]);

    const result = await ok(client, "ct_list_appointments", {
      calendar_ids: [3],
    });

    expect(result.appointments).toEqual([{ id: 9, calendarId: 3 }]);
  },
);

test("list appointments keeps every occurrence of a series apart, all-day and timed alike", async () => {
  const daily = { id: 9, title: "Freizeit", repeatId: 1, calendar };
  const { client } = await ready([
    json({
      data: [
        {
          base: daily,
          calculated: { startDate: "2028-02-28", endDate: "2028-02-28" },
        },
        {
          base: daily,
          calculated: { startDate: "2028-02-29", endDate: "2028-02-29" },
        },
        {
          base: { ...timed, id: 10 },
          calculated: {
            startDate: "2028-02-29T08:00:00Z",
            endDate: "2028-02-29T09:00:00Z",
          },
        },
      ],
    }),
  ]);

  const result = await ok(client, "ct_list_appointments", {
    calendar_ids: [3],
  });

  expect(
    (result.appointments as { startDate: string }[]).map((a) => a.startDate),
  ).toEqual(["2028-02-28", "2028-02-29", "2028-02-29T08:00:00Z"]);
});

// ct_list_appointments: date boundaries

test.each([
  { from: "2028-02-29", to: "2028-03-01" },
  { from: "2000-02-29" },
  { from: "2026-03-28", to: "2026-03-29" },
  { from: "2026-10-25", to: "2026-10-26" },
  { from: "2026-12-31", to: "2027-01-01" },
  { to: "2026-10-01" },
])("list appointments accepts the day range %j", async (range) => {
  const { client, calls } = await ready([json({ data: [] })]);

  await ok(client, "ct_list_appointments", { calendar_ids: [3], ...range });

  const sent = query(calls[0]?.path ?? "");
  expect(sent.get("from")).toBe(range.from ?? null);
  expect(sent.get("to")).toBe(range.to ?? null);
});

test.each([
  { from: "2027-02-29" },
  { from: "2100-02-29" },
  { to: "2026-04-31" },
  { from: "2026-10-1" },
  { from: "" },
])("list appointments rejects the impossible day %j", async (range) => {
  const { client, calls } = await ready([]);

  await fails(client, "ct_list_appointments", { calendar_ids: [3], ...range });

  expect(calls).toHaveLength(0);
});

test("list appointments with a duplicate calendar id still answers what the server returns", async () => {
  const { client, calls } = await ready([json({ data: [] })]);

  const result = await ok(client, "ct_list_appointments", {
    calendar_ids: [3, 3],
  });

  expect(result).toEqual({ appointments: [] });
  expect(query(calls[0]?.path ?? "").getAll("calendar_ids[]")).toContain("3");
});

// ct_create_appointment: date boundaries

test.each([
  ["leap day", "2028-02-29T10:00:00Z", "2028-02-29T11:00:00Z"],
  ["spring DST night", "2026-03-29T01:30:00Z", "2026-03-29T02:30:00Z"],
  ["autumn DST night", "2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z"],
  ["midnight", "2026-12-31T23:00:00Z", "2027-01-01T00:00:00Z"],
])(
  "create sends a %s time unchanged, in UTC",
  async (_name, startDate, endDate) => {
    const { client } = await ready([]);

    const p = await plan(client, "ct_create_appointment", {
      calendarId: 3,
      title: "Nachtcafé",
      startDate,
      endDate,
    });

    expect(p.preview.changes[0]?.fields).toMatchObject({
      startDate: { after: startDate },
      endDate: { after: endDate },
    });
  },
);

test.each(["2027-02-29T10:00:00Z", "2026-10-25T24:00:00Z", "2027-02-29"])(
  "create rejects the impossible date %s without a request",
  async (startDate) => {
    const { client, calls } = await ready([]);

    await fails(client, "ct_create_appointment", {
      calendarId: 3,
      title: "x",
      startDate,
      endDate: "2027-03-01",
    });

    expect(calls).toHaveLength(0);
  },
);

// ct_update_appointment: date fields only

test("update that moves only the dates of a timed appointment previews and sends just those", async () => {
  const { client, calls } = await ready([
    json(record(timed)),
    json(record(timed)),
    json({ data: timed }),
  ]);

  const p = await plan(client, "ct_update_appointment", {
    ...ids,
    startDate: "2026-10-18T08:00:00Z",
    endDate: "2026-10-18T09:30:00Z",
  });
  await ok(client, "ct_execute_plan", { token: p.token });

  expect(p.preview.changes[0]?.fields).toEqual({
    startDate: {
      before: "2026-10-11T08:00:00Z",
      after: "2026-10-18T08:00:00Z",
    },
    endDate: { before: "2026-10-11T09:30:00Z", after: "2026-10-18T09:30:00Z" },
  });
  expect(p.preview).not.toHaveProperty("warning");
  expect(calls[2]?.body).toEqual({
    ...timed,
    startDate: "2026-10-18T08:00:00Z",
    endDate: "2026-10-18T09:30:00Z",
    calendarId: 3,
    appointmentId: 42,
  });
});

test("update that makes a timed appointment all-day sends no contradicting allDay false", async () => {
  const { client, calls } = await ready([
    json(record(timed)),
    json(record(timed)),
    json({ data: allDay }),
  ]);

  const p = await plan(client, "ct_update_appointment", {
    ...ids,
    startDate: "2026-10-11",
    endDate: "2026-10-11",
  });
  await ok(client, "ct_execute_plan", { token: p.token });

  const body = calls[2]?.body as Record<string, unknown>;
  expect(body.startDate).toBe("2026-10-11");
  expect(body.allDay).not.toBe(false);
});

test("update that gives an all-day appointment a time sends no contradicting allDay true", async () => {
  const { client, calls } = await ready([
    json(record(allDay)),
    json(record(allDay)),
    json({ data: timed }),
  ]);

  const p = await plan(client, "ct_update_appointment", {
    ...ids,
    startDate: "2026-10-11T08:00:00Z",
    endDate: "2026-10-11T09:30:00Z",
  });
  await ok(client, "ct_execute_plan", { token: p.token });

  const body = calls[2]?.body as Record<string, unknown>;
  expect(body.startDate).toBe("2026-10-11T08:00:00Z");
  expect(body.allDay).not.toBe(true);
});

// ct_update_appointment: same value

test.each([
  ["a padded same title", { title: `  ${timed.title}  ` }],
  ["the same start", { startDate: timed.startDate }],
  ["the same isInternal", { isInternal: false }],
  [
    "the same nested calendar in another key order",
    { fields: { calendar: { isPublic: true, name: "Gottesdienste", id: 3 } } },
  ],
  ["the same empty exceptions", { fields: { exceptions: [] } }],
])("update with %s is no change and makes no plan", async (_name, change) => {
  const { client } = await ready([json(record(timed))]);

  const text = await fails(client, "ct_update_appointment", {
    ...ids,
    ...change,
  });

  expect(text).toContain("No change");
  expect(text).not.toContain("token");
});

test("update that clears a field the record lacks previews it as absent and sends null", async () => {
  const bare = without(timed, "subtitle");
  const { client, calls } = await ready([
    json(record(bare)),
    json(record(bare)),
    json({ data: bare }),
  ]);

  const p = await plan(client, "ct_update_appointment", {
    ...ids,
    fields: { subtitle: null },
  });
  await ok(client, "ct_execute_plan", { token: p.token });

  expect(p.preview.changes[0]?.fields).toEqual({
    subtitle: { before: "(absent)", after: null },
  });
  expect((calls[2]?.body as Record<string, unknown>).subtitle).toBeNull();
});

// ct_update_appointment: preview vs sent body

test("update previews exactly the fields whose sent value differs from the stored record", async () => {
  const stored = {
    ...timed,
    caption: timed.title,
    information: "",
    "@deprecated": { caption: "title" },
  };
  const { client, calls } = await ready([
    json(record(stored)),
    json(record(stored)),
    json({ data: timed }),
  ]);

  const p = await plan(client, "ct_update_appointment", {
    ...ids,
    endDate: "2026-10-11T10:00:00Z",
    fields: { description: "Mit Chor" },
  });
  await ok(client, "ct_execute_plan", { token: p.token });

  const sent = calls[2]?.body as Record<string, unknown>;
  const differs = Object.keys(sent).filter(
    (k) =>
      JSON.stringify(sent[k]) !==
      JSON.stringify((stored as Record<string, unknown>)[k]),
  );
  expect(Object.keys(p.preview.changes[0]?.fields ?? {}).sort()).toEqual(
    differs.filter((k) => k !== "calendarId" && k !== "appointmentId").sort(),
  );
  for (const alias of ["caption", "information", "@deprecated"]) {
    expect(sent).not.toHaveProperty(alias);
  }
});

test("update rejects a deprecated alias in fields, as it would be sent beside the real field", async () => {
  const stored = { ...timed, information: "Alt" };
  const { client, calls } = await ready([json(record(stored))]);

  await fails(client, "ct_update_appointment", {
    ...ids,
    fields: { information: "Neu" },
  });

  expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
});

test("update of a record without a title key is an error and makes no plan", async () => {
  const untitled = without(timed, "title");
  const { client } = await ready([json(record(untitled))]);

  const text = await fails(client, "ct_update_appointment", {
    ...ids,
    title: "Neu",
  });

  expect(text).not.toContain("token");
});

// Series detection

test.each([
  [0, false],
  [1, true],
  [7, true],
  [31, true],
  [32, true],
  [365, true],
  [999, true],
  [null, true],
  ["0", true],
  [-1, true],
])(
  "update and delete with repeatId %j warn about the series: %s",
  async (repeatId, warns) => {
    const stored = { ...timed, repeatId };
    const { client } = await ready([
      json(record(stored)),
      json(record(stored)),
    ]);

    const update = await plan(client, "ct_update_appointment", {
      ...ids,
      title: "Neu",
    });
    const remove = await plan(client, "ct_delete_appointment", ids);

    for (const p of [update, remove]) {
      expect(Object.hasOwn(p.preview, "warning")).toBe(warns);
    }
  },
);

test("delete of an appointment without a repeatId warns, as the series state is unknown", async () => {
  const unknown = without(timed, "repeatId");
  const { client } = await ready([json(record(unknown))]);

  const p = await plan(client, "ct_delete_appointment", ids);

  expect(p.preview.warning).toMatch(/repeatId unknown/);
});

test("delete of a single appointment with additional dates warns that every date goes", async () => {
  const stored = {
    ...timed,
    additionals: [{ id: 5, date: "2026-10-18", meta: {} }],
  };
  const { client } = await ready([json(record(stored))]);

  const p = await plan(client, "ct_delete_appointment", ids);

  expect(p.preview).toHaveProperty("warning");
});

test("delete asked for one occurrence date still plans the whole series and says so", async () => {
  const series = { ...timed, repeatId: 7, repeatUntil: "2026-12-20" };
  const { client, calls } = await ready([
    json(record(series)),
    json(record(series)),
    new Response(null, { status: 204 }),
  ]);

  const p = await plan(client, "ct_delete_appointment", {
    ...ids,
    date: "2026-10-18",
  });
  await ok(client, "ct_execute_plan", { token: p.token });

  expect(p.preview.warning).toMatch(/whole series/);
  expect(calls[2]?.path).toBe(path);
  expect(calls[2]?.method).toBe("DELETE");
});

// Guards

test.each([
  ["ct_update_appointment", { title: "Neu" }],
  ["ct_delete_appointment", {}],
])(
  "%s after the appointment was deleted writes nothing",
  async (tool, args) => {
    const { client, writes } = await ready([json(record(timed)), notFound()]);
    const p = await plan(client, tool, { ...ids, ...args });

    const text = await fails(client, "ct_execute_plan", { token: p.token });

    expect(text).toContain("Nothing was written");
    expect(text).toContain("no longer exists");
    expect(writes()).toHaveLength(0);
  },
);

test("delete after the appointment changed writes nothing and names the changed field", async () => {
  const { client, writes } = await ready([
    json(record(timed)),
    json(record({ ...timed, endDate: "2026-10-11T10:00:00Z" })),
  ]);
  const p = await plan(client, "ct_delete_appointment", ids);

  const text = await fails(client, "ct_execute_plan", { token: p.token });

  expect(text).toContain("Nothing was written");
  expect(text).toContain("appointment");
  expect(writes()).toHaveLength(0);
});

test("an update plan runs once: a second execute writes nothing more", async () => {
  const { client, writes } = await ready([
    json(record(timed)),
    json(record(timed)),
    json({ data: timed }),
  ]);
  const p = await plan(client, "ct_update_appointment", {
    ...ids,
    title: "Neu",
  });

  await ok(client, "ct_execute_plan", { token: p.token });
  await fails(client, "ct_execute_plan", { token: p.token });

  expect(writes()).toHaveLength(1);
});

// Secrets

test.each([
  ["ct_update_appointment", { title: "Neu" }],
  ["ct_delete_appointment", {}],
  ["ct_get_appointment", {}],
])(
  "%s of an HTML error page leaks neither cookie nor CSRF token",
  async (tool, args) => {
    const { client } = await ready([
      new Response(`<html>${cookieValue} ${csrfToken}</html>`, {
        status: 500,
      }),
    ]);

    await fails(client, tool, { ...ids, ...args });
  },
);

// Re-attack of the allDay fix: the form of the dates says allDay

test.each([
  ["an all-day appointment a timed end", allDay, "2026-10-11T10:00:00Z"],
  ["a timed appointment an all-day end", timed, "2026-10-12"],
])(
  "update that gives %s only is rejected, as start and end would differ in form",
  async (_name, stored, endDate) => {
    const { client } = await ready([json(record(stored))]);

    const text = await fails(client, "ct_update_appointment", {
      ...ids,
      endDate,
    });

    expect(text).not.toContain("token");
  },
);

test("update rejects allDay in fields, as the form of the dates says it", async () => {
  const { client } = await ready([json(record(timed))]);

  const text = await fails(client, "ct_update_appointment", {
    ...ids,
    fields: { allDay: true },
  });

  expect(text).not.toContain("token");
});

test("update to an all-day date previews allDay before and after", async () => {
  const { client } = await ready([json(record(timed))]);

  const p = await plan(client, "ct_update_appointment", {
    ...ids,
    startDate: "2026-10-12",
    endDate: "2026-10-12",
  });

  expect(p.preview.changes[0]?.fields?.allDay).toEqual({
    before: false,
    after: true,
  });
});
