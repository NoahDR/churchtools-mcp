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

/** A group in a production-like shape: nulls, nested objects, arrays, unicode. */
const odd = {
  id: 5,
  name: "Jugend Süd & Ørsted",
  information: {
    groupTypeId: 2,
    groupStatusId: 3,
    note: "",
    campusId: null,
    ageGroupIds: [1, 4],
  },
  settings: {
    visibility: "hidden",
    groupMeeting: { isActive: true, templateId: null },
    statusesCountedTowardsSeats: ["active"],
  },
  roles: [{ id: 8, name: "Leiter" }],
};
/** A membership whose person and group have no display title. */
const bare = {
  id: 71,
  personId: 13,
  groupTypeRoleId: 8,
  groupMemberStatus: "to_delete",
  comment: "Zoë's note",
  memberStartDate: null,
  memberEndDate: null,
  person: null,
  fields: [{ id: 1, value: "x" }],
};
const notFound = () =>
  json({ message: "Group member not found" }, { status: 404 });

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

// Searches

test("group search sends a trimmed unicode query with reserved characters intact", async () => {
  const words = "Zoë Ørsted & Co #1 ?x=1 / 100%";
  const { client, calls } = await ready([json({ data: [] })]);

  await ok(client, "ct_search_groups", { query: `  ${words}  ` });

  expect(query(calls[0]?.path ?? "").get("query")).toBe(words);
});

test("group search with empty id lists sends no id parameters", async () => {
  const { client, requests } = await ready([json({ data: [] })]);

  await ok(client, "ct_search_groups", {
    group_type_ids: [],
    group_status_ids: [],
  });

  expect(requests()).toEqual([`GET ${api}/groups`]);
});

test("group search lists only the compact fields of odd-shaped groups", async () => {
  const { client } = await ready([
    json({ data: [odd, { id: 6, name: "Bare" }] }),
  ]);

  const result = await ok(client, "ct_search_groups", {});

  expect(result).toEqual({
    groups: [
      { id: 5, name: "Jugend Süd & Ørsted", groupTypeId: 2, groupStatusId: 3 },
      { id: 6, name: "Bare" },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("Leiter");
  expect(JSON.stringify(result)).not.toContain("hidden");
});

test.each([
  ["ct_search_groups", {}],
  ["ct_list_group_members", { groupId: 5 }],
])("%s with a malformed meta still returns the list", async (tool, args) => {
  const { client } = await ready([
    json({ data: [], meta: { pagination: { current: "1" } } }),
  ]);

  const result = await ok(client, tool, args);

  expect(Object.keys(result)).toHaveLength(1);
});

test("member list of a membership without a person title omits the name and every other field", async () => {
  const { client } = await ready([json({ data: [bare] })]);

  const result = await ok(client, "ct_list_group_members", { groupId: 5 });

  expect(result).toEqual({
    members: [
      { personId: 13, groupTypeRoleId: 8, groupMemberStatus: "to_delete" },
    ],
  });
});

test("member list sends a trimmed query", async () => {
  const { client, calls } = await ready([json({ data: [] })]);

  await ok(client, "ct_list_group_members", {
    groupId: 5,
    query: "  Ben ",
  });

  expect(query(calls[0]?.path ?? "").get("query")).toBe("Ben");
});

test("member list answered without a data list does not echo the body", async () => {
  const { client } = await ready([json({ members: cookieValue })]);

  const text = await fails(client, "ct_list_group_members", { groupId: 5 });

  expect(text).toContain("Unexpected answer from /groups/5/members");
});

// ct_create_group

test("create trims the name and posts nested, null and unicode fields exactly as previewed", async () => {
  const fields = {
    note: null,
    campusId: 2,
    ageGroupIds: [4, 1],
    groupMeeting: { isActive: true, templateId: null },
    imageAnnotation: "Zoë",
  };
  const { client, calls } = await ready([json({ data: { id: 9 } })]);
  const p = await plan(client, "ct_create_group", {
    name: "  Jugend Süd ",
    groupTypeId: 2,
    groupStatusId: 1,
    fields,
  });

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(p.preview.summary).toBe("Create group Jugend Süd");
  expect(calls[0]?.body).toEqual(afterValues(p));
  expect(calls[0]?.body).toMatchObject({ ...fields, name: "Jugend Süd" });
});

test("the typed name, type and status win over the same keys in fields, and force is never sent", async () => {
  const { client } = await ready([]);

  const p = await plan(client, "ct_create_group", {
    name: "Youth",
    groupTypeId: 1,
    groupStatusId: 1,
    fields: { name: "Mallory", groupTypeId: 9, groupStatusId: 3, force: true },
  });

  expect(afterValues(p)).toEqual({
    name: "Youth",
    groupTypeId: 1,
    groupStatusId: 1,
  });
});

test("a create refused by ChurchTools reports the message and that nothing was written", async () => {
  const { client } = await ready([
    json(
      {
        message: "Group with this name already exists",
        args: { duplicateGroupId: 5 },
      },
      { status: 400 },
    ),
  ]);
  const p = await plan(client, "ct_create_group", {
    name: "Youth",
    groupTypeId: 1,
    groupStatusId: 1,
  });

  const text = await fails(client, "ct_execute_plan", { token: p.token });
  const error = JSON.parse(text) as { error: string; args: unknown };

  expect(error.error).toContain("Group with this name already exists");
  expect(error.error).toContain("Written: nothing");
  expect(error.args).toEqual({ duplicateGroupId: 5 });
});

// ct_update_group

test("update of odd-shaped values patches exactly the previewed fields, null and nested kept", async () => {
  const fields = {
    name: "Jugend Süd & Ørsted",
    note: null,
    campusId: null,
    ageGroupIds: [4, 1],
    groupMeeting: { templateId: null, isActive: true },
    statusesCountedTowardsSeats: [],
    information: { note: "nested" },
  };
  const { client, calls } = await ready([
    json({ data: odd }),
    json({ data: odd }),
    json({ data: odd }),
  ]);
  const p = await plan(client, "ct_update_group", { groupId: 5, fields });

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(p.preview.changes[0]?.fields).toEqual({
    note: { before: "", after: null },
    ageGroupIds: { before: [1, 4], after: [4, 1] },
    statusesCountedTowardsSeats: { before: ["active"], after: [] },
    information: { before: odd.information, after: { note: "nested" } },
  });
  expect(calls[2]?.method).toBe("PATCH");
  expect(calls[2]?.body).toEqual(afterValues(p));
});

test("a second plan on the same group aborts after the first one ran", async () => {
  const changed = { ...odd, information: { ...odd.information, note: "1" } };
  const { client, writes } = await ready([
    json({ data: odd }),
    json({ data: odd }),
    json({ data: odd }),
    json({ data: changed }),
    json({ data: changed }),
  ]);
  const first = await plan(client, "ct_update_group", {
    groupId: 5,
    fields: { note: "1" },
  });
  const second = await plan(client, "ct_update_group", {
    groupId: 5,
    fields: { note: "2" },
  });

  await ok(client, "ct_execute_plan", { token: first.token });
  const text = await fails(client, "ct_execute_plan", { token: second.token });

  expect(text).toContain("Nothing was written");
  expect(text).toContain("information");
  expect(writes()).toHaveLength(1);
});

test("a summary of a group without a name says only the group id", async () => {
  const { client } = await ready([json({ data: { id: 5 } })]);

  const p = await plan(client, "ct_delete_group", { groupId: 5 });

  expect(p.preview.summary).toBe("Delete group 5");
});

// ct_delete_group

test("a delete refused with 409 reports the message and nothing written", async () => {
  const { client } = await ready([
    json({ data: odd }),
    json({ data: odd }),
    json({ message: "Group has child groups" }, { status: 409 }),
  ]);
  const p = await plan(client, "ct_delete_group", { groupId: 5 });

  const text = await fails(client, "ct_execute_plan", { token: p.token });
  const error = JSON.parse(text) as { error: string };

  expect(error.error).toContain("Group has child groups");
  expect(error.error).toContain("Written: nothing");
  expect(error.error).not.toContain("may still have been applied");
});

test("a delete preview shows the whole odd-shaped group and the delete sends no body", async () => {
  const { client, calls } = await ready([
    json({ data: odd }),
    json({ data: odd }),
    new Response(null, { status: 204 }),
  ]);
  const p = await plan(client, "ct_delete_group", { groupId: 5 });

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(p.preview.changes[0]?.record).toEqual(odd);
  expect(p.preview.changes[0]).not.toHaveProperty("body");
  expect(calls[2]?.path).toBe(`${api}/groups/5`);
  expect(calls[2]?.body).toBeUndefined();
});

test.each(["update", "delete"])(
  "a group %s whose group was deleted since the preview writes nothing",
  async (kind) => {
    const { client, writes } = await ready([
      json({ data: odd }),
      json({ message: "Group not found" }, { status: 404 }),
    ]);
    const args =
      kind === "update"
        ? { groupId: 5, fields: { note: "1" } }
        : { groupId: 5 };
    const p = await plan(client, `ct_${kind}_group`, args);

    const text = await fails(client, "ct_execute_plan", { token: p.token });

    expect(text).toContain("no longer exists");
    expect(writes()).toHaveLength(0);
  },
);

// ct_add_group_member

test("add sends only the given fields: undefined dropped, as previewed", async () => {
  const { client, calls } = await ready([
    notFound(),
    notFound(),
    json({ data: bare }),
  ]);
  const p = await plan(client, "ct_add_group_member", {
    groupId: 5,
    personId: 13,
    comment: "Zoë's note",
  });

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(calls[2]?.method).toBe("PUT");
  expect(calls[2]?.body).toEqual({ comment: "Zoë's note" });
  expect(calls[2]?.body).toEqual(afterValues(p));
});

test("add of a membership pending removal is still 'already a member' and names its status", async () => {
  const { client } = await ready([json({ data: bare })]);

  const text = await fails(client, "ct_add_group_member", {
    groupId: 5,
    personId: 13,
  });

  expect(text).toContain("already a member");
  expect(text).toContain("to_delete");
});

test.each([
  [
    json({ message: "Keine Berechtigung" }, { status: 403 }),
    "Keine Berechtigung",
  ],
  [new Response(`<html>${cookieValue}</html>`, { status: 500 }), "HTTP 500"],
  [json({ ...bare }), "data envelope"],
])(
  "add whose membership check fails is an error, not a plan (%#)",
  async (answer, message) => {
    const { client, requests } = await ready([answer]);

    const text = await fails(client, "ct_add_group_member", {
      groupId: 5,
      personId: 13,
    });

    expect(text).toContain(message);
    expect(text).not.toContain("token");
    expect(requests()).toHaveLength(1);
  },
);

test("an add whose guard cannot be re-read writes nothing", async () => {
  const { client, writes } = await ready([
    notFound(),
    new Response(`<html>${cookieValue}</html>`, { status: 500 }),
  ]);
  const p = await plan(client, "ct_add_group_member", {
    groupId: 5,
    personId: 13,
  });

  const text = await fails(client, "ct_execute_plan", { token: p.token });

  expect(text).toContain("could not be re-read");
  expect(writes()).toHaveLength(0);
});

test("an add refused at execution reports the field errors and nothing written", async () => {
  const { client } = await ready([
    notFound(),
    notFound(),
    json(
      {
        message: "Group is full",
        errors: [{ fieldId: "groupTypeRoleId", message: "full" }],
      },
      { status: 400 },
    ),
  ]);
  const p = await plan(client, "ct_add_group_member", {
    groupId: 5,
    personId: 13,
  });

  const text = await fails(client, "ct_execute_plan", { token: p.token });
  const error = JSON.parse(text) as { error: string; errors: unknown };

  expect(error.error).toContain("Group is full");
  expect(error.error).toContain("Written: nothing");
  expect(error.errors).toEqual([
    { fieldId: "groupTypeRoleId", message: "full" },
  ]);
});

test.each([
  { memberStartDate: "01.10.2026" },
  { memberStartDate: "2026-13-01" },
  { groupMemberStatus: "gone" },
  { groupMemberStatus: null },
])("add rejects %j without a request", async (args) => {
  const { client, calls } = await ready([]);

  await fails(client, "ct_add_group_member", {
    groupId: 5,
    personId: 13,
    ...args,
  });

  expect(calls).toHaveLength(0);
});

// ct_update_group_member

test("member update to null patches null as previewed and keeps unchanged fields out", async () => {
  const { client, calls } = await ready([
    json({ data: bare }),
    json({ data: bare }),
    json({ data: bare }),
  ]);
  const p = await plan(client, "ct_update_group_member", {
    groupId: 5,
    personId: 13,
    comment: null,
    memberStartDate: "2026-10-01",
    memberEndDate: null,
    groupTypeRoleId: 8,
  });

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(p.preview.changes[0]?.fields).toEqual({
    comment: { before: "Zoë's note", after: null },
    memberStartDate: { before: null, after: "2026-10-01" },
  });
  expect(calls[2]?.body).toEqual(afterValues(p));
});

test("a member summary without person and group titles says only the ids", async () => {
  const { client } = await ready([json({ data: bare })]);

  const p = await plan(client, "ct_remove_group_member", {
    groupId: 5,
    personId: 13,
  });

  expect(p.preview.summary).toBe("Remove person 13 from group 5");
});

test.each([
  { memberEndDate: "2026-02-30" },
  { groupMemberStatus: "gone" },
  { comment: 5 },
])("member update rejects %j without a request", async (args) => {
  const { client, calls } = await ready([]);

  await fails(client, "ct_update_group_member", {
    groupId: 5,
    personId: 13,
    ...args,
  });

  expect(calls).toHaveLength(0);
});

// ct_remove_group_member

test.each([
  [json({ data: { ...bare, groupTypeRoleId: 9 } }), "groupTypeRoleId"],
  [notFound(), "no longer exists"],
])(
  "a remove whose membership changed since the preview writes nothing (%#)",
  async (reread, message) => {
    const { client, writes } = await ready([json({ data: bare }), reread]);
    const p = await plan(client, "ct_remove_group_member", {
      groupId: 5,
      personId: 13,
    });

    const text = await fails(client, "ct_execute_plan", { token: p.token });

    expect(text).toContain("Nothing was written");
    expect(text).toContain(message);
    expect(writes()).toHaveLength(0);
  },
);

test("a write failing with an HTML 500 does not echo the body and says it may have been applied", async () => {
  const { client } = await ready([
    json({ data: bare }),
    json({ data: bare }),
    new Response(`<html>${cookieValue}</html>`, { status: 500 }),
  ]);
  const p = await plan(client, "ct_remove_group_member", {
    groupId: 5,
    personId: 13,
  });

  const text = await fails(client, "ct_execute_plan", { token: p.token });

  expect(text).toContain("HTTP 500");
  expect(text).toContain("may still have been applied");
});

test("a 401 at execution asks for the 2FA code and writes nothing", async () => {
  const { client, writes } = await ready([
    json({ data: bare }),
    json({ message: "Session expired!" }, { status: 401 }),
  ]);
  const p = await plan(client, "ct_remove_group_member", {
    groupId: 5,
    personId: 13,
  });

  const text = await fails(client, "ct_execute_plan", { token: p.token });

  expect(text).toContain("ct_login");
  expect(writes()).toHaveLength(0);
});

// Lenient reads

test("a field in both settings and information compares against settings, as information.maxMembers is deprecated", async () => {
  const both = {
    ...odd,
    information: { ...odd.information, maxMembers: 10 },
    settings: { ...odd.settings, maxMembers: 20 },
  };
  const { client } = await ready([json({ data: both }), json({ data: both })]);

  const same = await fails(client, "ct_update_group", {
    groupId: 5,
    fields: { maxMembers: 20 },
  });
  const p = await plan(client, "ct_update_group", {
    groupId: 5,
    fields: { maxMembers: 10 },
  });

  expect(same).toContain("No change");
  expect(p.preview.changes[0]?.fields).toEqual({
    maxMembers: { before: 20, after: 10 },
  });
});

test("member reads treat a PHP empty array as person or group as untitled", async () => {
  const phpEmpty = { ...bare, person: [], group: [] };
  const { client } = await ready([
    json({ data: [phpEmpty] }),
    json({ data: phpEmpty }),
  ]);

  const list = await ok(client, "ct_list_group_members", { groupId: 5 });
  const p = await plan(client, "ct_remove_group_member", {
    groupId: 5,
    personId: 13,
  });

  expect(list.members).toEqual([
    { personId: 13, groupTypeRoleId: 8, groupMemberStatus: "to_delete" },
  ]);
  expect(p.preview.summary).toBe("Remove person 13 from group 5");
});
