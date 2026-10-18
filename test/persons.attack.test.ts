import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, test } from "vitest";
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

/** A person in a production-like shape: names missing, nulls, nested objects and arrays. */
const odd = {
  id: 12,
  lastName: "Ørsted-Müßig",
  email: null,
  statusId: null,
  emails: [{ email: "o@example.org", isDefault: true, contactLabelId: 2 }],
  campus: { id: 1, name: "Nord", meta: { tags: ["a", "b"] } },
  departmentIds: [1, 3],
  birthday: null,
  mobile: "",
  privacyPolicyAgreement: { date: "2024-01-02", typeId: 1, whoId: 7 },
};

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

const query = (path: string) => new URL(path, "https://x").searchParams;
const afterValues = (p: Plan) =>
  Object.fromEntries(
    Object.entries(p.preview.changes[0]?.fields ?? {}).map(([k, v]) => [
      k,
      v.after,
    ]),
  );

// ct_search_persons

test("search sends a unicode and reserved-character query intact", async () => {
  const words = "Zoë Ørsted & Co #1 ?x=1 / 100%";
  const { client, calls } = await ready([json({ data: [] })]);

  await ok(client, "ct_search_persons", { query: words, email: "a+b@x.org" });

  expect(query(calls[0]?.path ?? "").get("query")).toBe(words);
  expect(query(calls[0]?.path ?? "").get("email")).toBe("a+b@x.org");
});

test("search with an empty status id list sends no status parameter", async () => {
  const { client, requests } = await ready([json({ data: [] })]);

  await ok(client, "ct_search_persons", { status_ids: [] });

  expect(requests()).toEqual([`GET ${api}/persons`]);
});

test.each([{ limit: 1e9 }, { limit: Number.MAX_SAFE_INTEGER + 2 }])(
  "search rejects the huge limit %j without a request",
  async (args) => {
    const { client, calls } = await ready([]);

    await fails(client, "ct_search_persons", args);

    expect(calls).toHaveLength(0);
  },
);

test("search of persons with missing names, nulls and nested fields lists only the compact fields", async () => {
  const { client } = await ready([
    json({ data: [odd, { id: 13, firstName: null, lastName: null }] }),
  ]);

  const result = await ok(client, "ct_search_persons", { query: "x" });

  expect(result).toEqual({
    persons: [
      { id: 12, lastName: "Ørsted-Müßig", email: null, statusId: null },
      { id: 13, firstName: null, lastName: null },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("o@example.org");
  expect(JSON.stringify(result)).not.toContain("Nord");
});

// ct_get_person

test("get returns a record with nested objects, arrays and nulls unchanged", async () => {
  const { client } = await ready([json({ data: odd })]);

  expect(await ok(client, "ct_get_person", { personId: 12 })).toEqual(odd);
});

// ct_create_person

test("create with unicode names checks duplicates by the full unicode name", async () => {
  const { client, calls } = await ready([json({ data: [] })]);

  const p = await plan(client, "ct_create_person", {
    firstName: "Zoë",
    lastName: "Ångström & Söhne",
    departmentIds: [1],
  });

  const sent = query(calls[0]?.path ?? "");
  expect(sent.get("firstName")).toBe("Zoë");
  expect(sent.get("lastName")).toBe("Ångström & Söhne");
  expect(p.preview.summary).toBe("Create person Zoë Ångström & Söhne");
});

test("create with duplicate department ids previews exactly what it posts", async () => {
  const { client, calls } = await ready([
    json({ data: [] }),
    json({ data: { id: 30 } }),
  ]);
  const p = await plan(client, "ct_create_person", {
    firstName: "A",
    lastName: "B",
    departmentIds: [2, 2, 1],
  });

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(calls[1]?.body).toEqual(afterValues(p));
  expect((calls[1]?.body as { departmentIds: unknown }).departmentIds).toEqual(
    afterValues(p).departmentIds,
  );
});

test("create never sends force, even when fields carries it", async () => {
  const { client } = await ready([json({ data: [] })]);

  const p = await plan(client, "ct_create_person", {
    firstName: "Ben",
    lastName: "Berg",
    departmentIds: [1],
    fields: { force: true },
  });

  expect(p.preview.changes[0]?.fields).not.toHaveProperty("force");
});

test("create posts nested, null and unicode fields exactly as previewed", async () => {
  const fields = {
    email: "zoë@example.org",
    birthday: null,
    campus: { name: "Süd", ids: [3, 1] },
    emails: [{ email: "z@x.org", isDefault: true }],
  };
  const { client, calls } = await ready([
    json({ data: [] }),
    json({ data: { id: 31 } }),
  ]);
  const p = await plan(client, "ct_create_person", {
    firstName: "Zoë",
    lastName: "Z",
    departmentIds: [1],
    fields,
  });

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(calls[1]?.method).toBe("POST");
  expect(calls[1]?.body).toEqual(afterValues(p));
  expect(calls[1]?.body).toMatchObject(fields);
});

test("a duplicate 400 at execution writes nothing and says it was not applied", async () => {
  const { client, writes } = await ready([
    json({ data: [] }),
    json(
      {
        message: "Duplicate found.",
        translatedMessage: "Doppelte Person gefunden.",
        messageKey: "forbidden.duplicate.person",
        args: { duplicatePersonId: 12 },
        errors: [],
      },
      { status: 400 },
    ),
  ]);
  const p = await plan(client, "ct_create_person", {
    firstName: "Ben",
    lastName: "Berg",
    departmentIds: [1],
  });

  const text = await fails(client, "ct_execute_plan", { token: p.token });
  const error = JSON.parse(text) as { error: string; args: unknown };

  expect(error.args).toEqual({ duplicatePersonId: 12 });
  expect(error.error).toContain("Doppelte Person gefunden.");
  expect(error.error).toContain("Written: nothing");
  expect(error.error).not.toContain("may still have been applied");
  expect(writes()).toHaveLength(1);
  expect(await fails(client, "ct_execute_plan", { token: p.token })).toContain(
    "already used",
  );
});

// ct_update_person

test("update to null of a field that is already null is no change", async () => {
  const { client } = await ready([json({ data: odd })]);

  const text = await fails(client, "ct_update_person", {
    personId: 12,
    fields: { birthday: null, email: null },
  });

  expect(text).toContain("No change");
});

test("update to null of an absent field patches null and shows it as absent before", async () => {
  const { client, calls } = await ready([
    json({ data: odd }),
    json({ data: odd }),
    json({ data: odd }),
  ]);
  const p = await plan(client, "ct_update_person", {
    personId: 12,
    fields: { firstName: null },
  });

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(p.preview.changes[0]?.fields).toEqual({
    firstName: { before: "(absent)", after: null },
  });
  expect(calls[2]?.body).toEqual({ firstName: null });
});

test("update with a nested object of the same content in another key order is no change", async () => {
  const { client } = await ready([json({ data: odd })]);

  const text = await fails(client, "ct_update_person", {
    personId: 12,
    fields: {
      campus: { meta: { tags: ["a", "b"] }, name: "Nord", id: 1 },
      emails: [{ isDefault: true, contactLabelId: 2, email: "o@example.org" }],
    },
  });

  expect(text).toContain("No change");
});

test("update with an array in another order is a change", async () => {
  const { client } = await ready([json({ data: odd })]);

  const p = await plan(client, "ct_update_person", {
    personId: 12,
    fields: { departmentIds: [3, 1] },
  });

  expect(p.preview.changes[0]?.fields).toEqual({
    departmentIds: { before: [1, 3], after: [3, 1] },
  });
});

test("update patches exactly the previewed fields for mixed nested, null, unicode and unchanged values", async () => {
  const fields = {
    lastName: "Ørsted-Müßig",
    mobile: null,
    campus: { id: 2, name: "Süd" },
    emails: [],
    nickname: "Zoë",
    statusId: 0,
  };
  const { client, calls } = await ready([
    json({ data: odd }),
    json({ data: odd }),
    json({ data: odd }),
  ]);
  const p = await plan(client, "ct_update_person", { personId: 12, fields });

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(calls[2]?.method).toBe("PATCH");
  expect(calls[2]?.body).toEqual(afterValues(p));
  expect(Object.keys(calls[2]?.body as object).sort()).toEqual([
    "campus",
    "emails",
    "mobile",
    "nickname",
    "statusId",
  ]);
});

test("a summary of a person with only a last name names that name", async () => {
  const { client } = await ready([json({ data: odd })]);

  const p = await plan(client, "ct_update_person", {
    personId: 12,
    fields: { mobile: "1" },
  });

  expect(p.preview.summary).toBe("Update person 12 (Ørsted-Müßig)");
});

test("a second plan on the same person aborts after the first one ran", async () => {
  const changed = { ...odd, mobile: "1" };
  const { client, writes } = await ready([
    json({ data: odd }),
    json({ data: odd }),
    json({ data: odd }),
    json({ data: changed }),
    json({ data: changed }),
  ]);
  const first = await plan(client, "ct_update_person", {
    personId: 12,
    fields: { mobile: "1" },
  });
  const second = await plan(client, "ct_update_person", {
    personId: 12,
    fields: { mobile: "2" },
  });

  await ok(client, "ct_execute_plan", { token: first.token });
  const text = await fails(client, "ct_execute_plan", {
    token: second.token,
  });

  expect(text).toContain("Nothing was written");
  expect(text).toContain("mobile");
  expect(writes()).toHaveLength(1);
});

test.each(["update", "delete"])(
  "a %s of a person deleted since the preview writes nothing",
  async (kind) => {
    const { client, writes } = await ready([
      json({ data: odd }),
      json({ message: "Person not found" }, { status: 404 }),
    ]);
    const args =
      kind === "update"
        ? { personId: 12, fields: { mobile: "1" } }
        : { personId: 12 };
    const p = await plan(client, `ct_${kind}_person`, args);

    const text = await fails(client, "ct_execute_plan", { token: p.token });

    expect(text).toContain("no longer exists");
    expect(writes()).toHaveLength(0);
  },
);

// ct_delete_person

test("a delete answered 404 reports nothing written and not applied", async () => {
  const { client } = await ready([
    json({ data: odd }),
    json({ data: odd }),
    json({ message: "Person not found" }, { status: 404 }),
  ]);
  const p = await plan(client, "ct_delete_person", { personId: 12 });

  const text = await fails(client, "ct_execute_plan", { token: p.token });
  const error = JSON.parse(text) as { error: string };

  expect(error.error).toContain("Person not found");
  expect(error.error).toContain("Written: nothing");
  expect(error.error).not.toContain("may still have been applied");
});

test("a delete preview shows the whole odd-shaped record and the delete sends no body", async () => {
  const { client, calls } = await ready([
    json({ data: odd }),
    json({ data: odd }),
    new Response(null, { status: 204 }),
  ]);
  const p = await plan(client, "ct_delete_person", { personId: 12 });

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(p.preview.changes[0]?.record).toEqual(odd);
  expect(p.preview.changes[0]).not.toHaveProperty("body");
  expect(calls[2]?.method).toBe("DELETE");
  expect(calls[2]?.body).toBeUndefined();
});

test("a write failing with an HTML 500 does not echo the body and says it may have been applied", async () => {
  const { client } = await ready([
    json({ data: odd }),
    json({ data: odd }),
    new Response(`<html>${cookieValue}</html>`, { status: 500 }),
  ]);
  const p = await plan(client, "ct_update_person", {
    personId: 12,
    fields: { mobile: "1" },
  });

  const text = await fails(client, "ct_execute_plan", { token: p.token });

  expect(text).toContain("HTTP 500");
  expect(text).toContain("may still have been applied");
});

test("the duplicate check matches names without surrounding spaces", async () => {
  const { client, calls } = await ready([json({ data: [] })]);

  await plan(client, "ct_create_person", {
    firstName: " Anna Lena ",
    lastName: "von Ørsted ",
    departmentIds: [1],
  });

  const sent = query(calls[0]?.path ?? "");
  expect(sent.get("firstName")).toBe("Anna Lena");
  expect(sent.get("lastName")).toBe("von Ørsted");
});

test("an update that sets only force does not claim the person already has it", async () => {
  const { client } = await ready([json({ data: odd })]);

  const text = await fails(client, "ct_update_person", {
    personId: 12,
    fields: { force: true },
  });

  expect(text).not.toContain("already has these values");
});
