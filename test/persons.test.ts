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
const ben = {
  id: 12,
  firstName: "Ben",
  lastName: "Berg",
  email: "ben@example.org",
  statusId: 1,
  birthday: "1990-01-01",
  mobile: "0170 555",
  street: "Hauptstr. 1",
  departmentIds: [1],
};
const compactBen = {
  id: 12,
  firstName: "Ben",
  lastName: "Berg",
  email: "ben@example.org",
  statusId: 1,
};
const pagination = { current: 1, lastPage: 3, limit: 10, total: 25 };

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
  return { client, calls, requests };
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
  preview: { changes: Record<string, unknown>[]; [key: string]: unknown };
}

const query = (path: string) => new URL(path, "https://x").searchParams;

// ct_search_persons

test("search sends query, email, status ids, archive flag, page and limit to GET /persons", async () => {
  const { client, calls, requests } = await ready([
    json({ data: [], meta: { pagination } }),
  ]);

  await ok(client, "ct_search_persons", {
    query: "Ben",
    email: "ben@example.org",
    status_ids: [1, 3],
    is_archived: false,
    page: 2,
    limit: 500,
  });

  expect(requests()).toEqual([expect.stringMatching(`^GET ${api}/persons\\?`)]);
  const sent = query(calls[0]?.path ?? "");
  expect(sent.get("query")).toBe("Ben");
  expect(sent.get("email")).toBe("ben@example.org");
  expect(sent.getAll("status_ids[]")).toEqual(["1", "3"]);
  expect(sent.get("is_archived")).toBe("false");
  expect(sent.get("page")).toBe("2");
  expect(sent.get("limit")).toBe("500");
});

test("search sends status id 0, the status unknown", async () => {
  const { client, calls } = await ready([json({ data: [] })]);

  await ok(client, "ct_search_persons", { status_ids: [0] });

  expect(query(calls[0]?.path ?? "").getAll("status_ids[]")).toEqual(["0"]);
});

test("search without filters sends no query parameters", async () => {
  const { client, requests } = await ready([json({ data: [] })]);

  await ok(client, "ct_search_persons", {});

  expect(requests()).toEqual([`GET ${api}/persons`]);
});

test("search returns only id, names, email and status of each person, plus the pagination", async () => {
  const { client } = await ready([json({ data: [ben], meta: { pagination } })]);

  const result = await ok(client, "ct_search_persons", { query: "Ben" });

  expect(result).toEqual({ persons: [compactBen], pagination });
});

test("search without meta or without pagination returns the persons only", async () => {
  const { client } = await ready([
    json({ data: [ben] }),
    json({ data: [ben], meta: { count: 1 } }),
  ]);

  expect(await ok(client, "ct_search_persons", {})).toEqual({
    persons: [compactBen],
  });
  expect(await ok(client, "ct_search_persons", {})).toEqual({
    persons: [compactBen],
  });
});

test("search with a malformed meta still returns the persons", async () => {
  const { client } = await ready([
    json({ data: [ben], meta: { pagination: { current: "1" } } }),
  ]);

  expect(await ok(client, "ct_search_persons", {})).toEqual({
    persons: [compactBen],
  });
});

test.each([
  { limit: 501 },
  { limit: 0 },
  { limit: 2.5 },
  { page: 0 },
  { status_ids: [-1] },
  { status_ids: ["1"] },
  { is_archived: "yes" },
])("search rejects %j without a request", async (args) => {
  const { client, calls } = await ready([]);

  await fails(client, "ct_search_persons", args);

  expect(calls).toHaveLength(0);
});

test("search answered without a data list is a clear error that does not echo the body", async () => {
  const { client } = await ready([json({ persons: cookieValue })]);

  const text = await fails(client, "ct_search_persons", {});

  expect(text).toContain("Unexpected answer from /persons");
});

// ct_get_person

test("get reads GET /persons/{id} and returns the record", async () => {
  const { client, requests } = await ready([json({ data: ben })]);

  const result = await ok(client, "ct_get_person", { personId: 12 });

  expect(result).toEqual(ben);
  expect(requests()).toEqual([`GET ${api}/persons/12`]);
});

test("get of an unknown person reports the server's message, not the raw body", async () => {
  const { client } = await ready([
    new Response(`<html>${cookieValue}</html>`, { status: 404 }),
    json({ message: "Person not found" }, { status: 404 }),
  ]);

  expect(await fails(client, "ct_get_person", { personId: 99 })).toContain(
    "HTTP 404",
  );
  expect(await fails(client, "ct_get_person", { personId: 99 })).toContain(
    "Person not found",
  );
});

const badIds = [0, -1, 1.5, "12", null];
const idTools: [string, Record<string, unknown>][] = [
  ["ct_get_person", {}],
  ["ct_update_person", { fields: { email: "x@example.org" } }],
  ["ct_delete_person", {}],
];

test.each(
  idTools.flatMap(([tool, args]) => badIds.map((id) => [tool, args, id])),
)(
  "%s rejects the person id %j without a request",
  async (tool, args, personId) => {
    const { client, calls } = await ready([]);

    await fails(client, tool as string, { ...(args as object), personId });

    expect(calls).toHaveLength(0);
  },
);

// Session

test("without a login every person tool asks for the 2FA code and sends nothing", async () => {
  const { fetch, calls } = fakeFetch();
  const client = await connectClient(fetch);
  const create = { firstName: "A", lastName: "B", departmentIds: [1] };

  for (const [tool, args] of [
    ["ct_search_persons", {}],
    ["ct_get_person", { personId: 12 }],
    ["ct_create_person", create],
    ["ct_update_person", { personId: 12, fields: { email: "x@y.org" } }],
    ["ct_delete_person", { personId: 12 }],
  ] as const) {
    expect(await fails(client, tool, args)).toContain(loginRequired);
  }
  expect(calls).toHaveLength(0);
});

test("a 401 on a person read logs out and asks for the 2FA code", async () => {
  const { client } = await ready([
    json({ message: "Session expired!" }, { status: 401 }),
  ]);

  const text = await fails(client, "ct_search_persons", {});
  const status = await ok(client, "ct_status");

  expect(text).toContain(loginRequired);
  expect(status.state).toBe("logged_out");
});

test.each([
  ["ct_get_person", { personId: 12 }],
  ["ct_update_person", { personId: 12, fields: { email: "x@example.org" } }],
  ["ct_delete_person", { personId: 12 }],
])("a 401 on the read of %s logs out and makes no plan", async (tool, args) => {
  const { client } = await ready([
    json({ message: "Session expired!" }, { status: 401 }),
  ]);

  const text = await fails(client, tool, args);
  const status = await ok(client, "ct_status");

  expect(text).toContain(loginRequired);
  expect(status.state).toBe("logged_out");
});

// ct_create_person

const newPerson = {
  firstName: "Clara",
  lastName: "Cole",
  departmentIds: [1, 2],
  fields: { email: "clara@example.org", birthday: null },
};
const sentBody = {
  email: "clara@example.org",
  birthday: null,
  firstName: "Clara",
  lastName: "Cole",
  departmentIds: [1, 2],
};

test("create looks for duplicates by name and writes nothing before ct_execute_plan", async () => {
  const { client, calls, requests } = await ready([json({ data: [] })]);

  await ok(client, "ct_create_person", newPerson);

  expect(requests()).toEqual([expect.stringMatching(`^GET ${api}/persons\\?`)]);
  const sent = query(calls[0]?.path ?? "");
  expect(sent.get("firstName")).toBe("Clara");
  expect(sent.get("lastName")).toBe("Cole");
  expect(sent.has("query")).toBe(false);
});

test("the duplicate check filters first and last name apart and lists the pair it finds", async () => {
  const { client, calls } = await ready([json({ data: [ben] })]);

  const plan = (await ok(client, "ct_create_person", {
    firstName: "Ben",
    lastName: "Berg",
    departmentIds: [1],
  })) as unknown as Plan;

  expect(calls[0]?.path).toBe(`${api}/persons?firstName=Ben&lastName=Berg`);
  expect(plan.preview.possibleDuplicates).toEqual([compactBen]);
});

test("create previews exactly the fields it sends, null kept", async () => {
  const { client } = await ready([json({ data: [] })]);

  const plan = (await ok(
    client,
    "ct_create_person",
    newPerson,
  )) as unknown as Plan;

  expect(plan.preview.changes).toEqual([
    {
      method: "POST",
      path: "/persons",
      fields: Object.fromEntries(
        Object.entries(sentBody).map(([k, after]) => [k, { after }]),
      ),
    },
  ]);
  expect(plan.preview.possibleDuplicates).toEqual([]);
});

test("create lists possible duplicates compactly in the preview", async () => {
  const { client } = await ready([json({ data: [ben] })]);

  const plan = (await ok(client, "ct_create_person", {
    firstName: "Ben",
    lastName: "Berg",
    departmentIds: [1],
  })) as unknown as Plan;

  expect(plan.preview.possibleDuplicates).toEqual([compactBen]);
});

test("a failed duplicate check is noted in the preview and does not block it", async () => {
  const { client } = await ready([
    new Response(`<html>${cookieValue}</html>`, { status: 500 }),
  ]);

  const plan = (await ok(
    client,
    "ct_create_person",
    newPerson,
  )) as unknown as Plan;

  expect(plan.token).toBeTruthy();
  expect(plan.preview.possibleDuplicates).toBe("not checked: HTTP 500");
});

test("a 401 on the duplicate check asks for the 2FA code and makes no plan", async () => {
  const { client } = await ready([
    json({ message: "Session expired!" }, { status: 401 }),
  ]);

  expect(await fails(client, "ct_create_person", newPerson)).toContain(
    loginRequired,
  );
});

test("the typed name and departments win over the same keys in fields", async () => {
  const { client } = await ready([json({ data: [] })]);

  const plan = (await ok(client, "ct_create_person", {
    ...newPerson,
    fields: { firstName: "Mallory", departmentIds: [] },
  })) as unknown as Plan;

  expect(plan.preview.changes[0]?.fields).toEqual({
    firstName: { after: "Clara" },
    departmentIds: { after: [1, 2] },
    lastName: { after: "Cole" },
  });
});

test.each([
  { firstName: "A", lastName: "B" },
  { firstName: "A", lastName: "B", departmentIds: [] },
  { firstName: "A", lastName: "B", departmentIds: [0] },
  { firstName: "A", lastName: "B", departmentIds: [1.5] },
  { firstName: " ", lastName: "B", departmentIds: [1] },
  { firstName: "A", departmentIds: [1] },
])("create rejects %j without a request", async (args) => {
  const { client, calls } = await ready([]);

  await fails(client, "ct_create_person", args);

  expect(calls).toHaveLength(0);
});

test("executing a create posts the previewed body without force", async () => {
  const { client, calls, requests } = await ready([
    json({ data: [] }),
    json({ data: { ...sentBody, id: 30 } }),
  ]);
  const plan = (await ok(
    client,
    "ct_create_person",
    newPerson,
  )) as unknown as Plan;

  await ok(client, "ct_execute_plan", { token: plan.token });

  expect(requests()[1]).toBe(`POST ${api}/persons`);
  expect(calls[1]?.body).toEqual(sentBody);
});

test("a duplicate refused by ChurchTools reaches the result with duplicatePersonId", async () => {
  const { client } = await ready([
    json({ data: [] }),
    json(
      {
        message:
          "Duplicate found. Use force flag to create person with same name.",
        messageKey: "forbidden.duplicate.person",
        args: { duplicatePersonId: 12 },
        errors: [],
      },
      { status: 400 },
    ),
  ]);
  const plan = (await ok(
    client,
    "ct_create_person",
    newPerson,
  )) as unknown as Plan;

  const text = await fails(client, "ct_execute_plan", { token: plan.token });

  expect(JSON.parse(text)).toMatchObject({
    error: expect.stringContaining("Duplicate found") as unknown,
    args: { duplicatePersonId: 12 },
  });
});

// ct_update_person

test("update previews before and after of the changed fields only and writes nothing", async () => {
  const { client, requests } = await ready([json({ data: ben })]);

  const plan = (await ok(client, "ct_update_person", {
    personId: 12,
    fields: { email: "ben@new.org", firstName: "Ben", mobile: null },
  })) as unknown as Plan;

  expect(plan.preview.changes).toEqual([
    {
      method: "PATCH",
      path: "/persons/12",
      fields: {
        email: { before: "ben@example.org", after: "ben@new.org" },
        mobile: { before: "0170 555", after: null },
      },
    },
  ]);
  expect(requests()).toEqual([`GET ${api}/persons/12`]);
});

test("executing an update re-reads the person, then patches only the changed fields", async () => {
  const { client, calls, requests } = await ready([
    json({ data: ben }),
    json({ data: ben }),
    json({ data: { ...ben, email: "ben@new.org" } }),
  ]);
  const plan = (await ok(client, "ct_update_person", {
    personId: 12,
    fields: { email: "ben@new.org", lastName: "Berg" },
  })) as unknown as Plan;

  await ok(client, "ct_execute_plan", { token: plan.token });

  expect(requests()).toEqual([
    `GET ${api}/persons/12`,
    `GET ${api}/persons/12`,
    `PATCH ${api}/persons/12`,
  ]);
  expect(calls[2]?.body).toEqual({ email: "ben@new.org" });
});

test("a person changed since the preview aborts the update with zero writes", async () => {
  const { client, requests } = await ready([
    json({ data: ben }),
    json({ data: { ...ben, mobile: "0171 000" } }),
  ]);
  const plan = (await ok(client, "ct_update_person", {
    personId: 12,
    fields: { email: "ben@new.org" },
  })) as unknown as Plan;

  const text = await fails(client, "ct_execute_plan", { token: plan.token });

  expect(text).toContain("mobile");
  expect(requests().filter((r) => !r.startsWith("GET"))).toEqual([]);
});

test("an update that changes nothing is a clear error and makes no plan", async () => {
  const { client } = await ready([json({ data: ben })]);

  const text = await fails(client, "ct_update_person", {
    personId: 12,
    fields: { email: "ben@example.org" },
  });

  expect(text).toContain("No change");
  expect(text).not.toContain("token");
});

test("an update of a field the record lacks shows its before as absent", async () => {
  const { client } = await ready([json({ data: ben })]);

  const plan = (await ok(client, "ct_update_person", {
    personId: 12,
    fields: { nickname: "Benny" },
  })) as unknown as Plan;

  expect(plan.preview.changes[0]?.fields).toEqual({
    nickname: { before: "(absent)", after: "Benny" },
  });
});

test("an update never patches force, even when fields carries it", async () => {
  const { client } = await ready([json({ data: ben })]);

  const plan = (await ok(client, "ct_update_person", {
    personId: 12,
    fields: { email: "ben@new.org", force: true },
  })) as unknown as Plan;

  expect(plan.preview.changes[0]?.fields).toEqual({
    email: { before: "ben@example.org", after: "ben@new.org" },
  });
});

test("an update without fields is rejected without a request", async () => {
  const { client, calls } = await ready([]);

  await fails(client, "ct_update_person", { personId: 12, fields: {} });

  expect(calls).toHaveLength(0);
});

test.each(["update", "delete"])(
  "a %s whose read answers without a data envelope makes no plan",
  async (kind) => {
    const { client } = await ready([json({ ...ben })]);
    const args =
      kind === "update"
        ? { personId: 12, fields: { email: "ben@new.org" } }
        : { personId: 12 };

    const text = await fails(client, `ct_${kind}_person`, args);

    expect(text).toContain("data envelope");
  },
);

test.each(["update", "delete"])(
  "a %s of an unknown person is an error and makes no plan",
  async (kind) => {
    const { client } = await ready([
      json({ message: "Person not found" }, { status: 404 }),
    ]);
    const args =
      kind === "update"
        ? { personId: 99, fields: { email: "x@example.org" } }
        : { personId: 99 };

    const text = await fails(client, `ct_${kind}_person`, args);

    expect(JSON.parse(text)).toMatchObject({
      error: "Person not found",
      status: 404,
    });
  },
);

// ct_delete_person

test("delete previews the whole record and writes nothing", async () => {
  const { client, requests } = await ready([json({ data: ben })]);

  const plan = (await ok(client, "ct_delete_person", {
    personId: 12,
  })) as unknown as Plan;

  expect(plan.preview.changes).toEqual([
    { method: "DELETE", path: "/persons/12", record: ben },
  ]);
  expect(requests()).toEqual([`GET ${api}/persons/12`]);
});

test("executing a delete re-reads the person, then deletes it without a body", async () => {
  const { client, calls, requests } = await ready([
    json({ data: ben }),
    json({ data: ben }),
    new Response(null, { status: 204 }),
  ]);
  const plan = (await ok(client, "ct_delete_person", {
    personId: 12,
  })) as unknown as Plan;

  await ok(client, "ct_execute_plan", { token: plan.token });

  expect(requests()).toEqual([
    `GET ${api}/persons/12`,
    `GET ${api}/persons/12`,
    `DELETE ${api}/persons/12`,
  ]);
  expect(calls[2]?.body).toBeUndefined();
});

// Summaries

test.each(["update", "delete"])(
  "a %s summary names the person from the guarded record",
  async (kind) => {
    const { client } = await ready([json({ data: ben })]);
    const args =
      kind === "update"
        ? { personId: 12, fields: { email: "ben@new.org" } }
        : { personId: 12 };

    const plan = (await ok(
      client,
      `ct_${kind}_person`,
      args,
    )) as unknown as Plan;

    expect(plan.preview.summary).toBe(
      `${kind === "update" ? "Update" : "Delete"} person 12 (Ben Berg)`,
    );
  },
);

test("a summary without name fields says only the person id", async () => {
  const { client } = await ready([
    json({ data: { id: 12, email: "a@b.org" } }),
  ]);

  const plan = (await ok(client, "ct_delete_person", {
    personId: 12,
  })) as unknown as Plan;

  expect(plan.preview.summary).toBe("Delete person 12");
});
