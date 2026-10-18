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
const youth = {
  id: 5,
  guid: "g-5",
  name: "Youth",
  information: {
    groupTypeId: 1,
    groupStatusId: 1,
    note: "Fridays",
    weekday: 5,
    campusId: null,
  },
  settings: { isOpenForMembers: false, visibility: "intern", maxMembers: 20 },
  roles: [{ id: 8, name: "Leader" }],
  memberStatistics: { total: 3 },
};
const compactYouth = {
  id: 5,
  name: "Youth",
  groupTypeId: 1,
  groupStatusId: 1,
};
const ben = {
  id: 70,
  personId: 12,
  groupTypeRoleId: 8,
  groupMemberStatus: "active",
  comment: null,
  memberStartDate: "2024-01-01",
  memberEndDate: null,
  person: { title: "Ben Berg", domainIdentifier: "12", domainType: "person" },
  group: { title: "Youth", domainIdentifier: "5", domainType: "group" },
  fields: [],
};
const compactBen = {
  personId: 12,
  name: "Ben Berg",
  groupTypeRoleId: 8,
  groupMemberStatus: "active",
};
const pagination = { current: 1, lastPage: 3, limit: 10, total: 25 };
const notFound = () =>
  json({ message: "Group member not found" }, { status: 404 });

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

// ct_search_groups

test("search sends query, type ids, status ids, page and limit to GET /groups", async () => {
  const { client, calls, requests } = await ready([
    json({ data: [], meta: { pagination } }),
  ]);

  await ok(client, "ct_search_groups", {
    query: "Youth",
    group_type_ids: [1, 2],
    group_status_ids: [1],
    page: 2,
    limit: 50,
  });

  expect(requests()).toEqual([expect.stringMatching(`^GET ${api}/groups\\?`)]);
  const sent = query(calls[0]?.path ?? "");
  expect(sent.get("query")).toBe("Youth");
  expect(sent.getAll("group_type_ids[]")).toEqual(["1", "2"]);
  expect(sent.getAll("group_status_ids[]")).toEqual(["1"]);
  expect(sent.get("page")).toBe("2");
  expect(sent.get("limit")).toBe("50");
});

test("search without filters sends no query parameters", async () => {
  const { client, requests } = await ready([json({ data: [] })]);

  await ok(client, "ct_search_groups", {});

  expect(requests()).toEqual([`GET ${api}/groups`]);
});

test("search returns only id, name, type and status of each group, plus the pagination", async () => {
  const { client } = await ready([
    json({ data: [youth], meta: { pagination } }),
  ]);

  const result = await ok(client, "ct_search_groups", { query: "Yo" });

  expect(result).toEqual({ groups: [compactYouth], pagination });
});

test("search without meta or without pagination returns the groups only", async () => {
  const { client } = await ready([
    json({ data: [youth] }),
    json({ data: [youth], meta: { count: 1 } }),
  ]);

  expect(await ok(client, "ct_search_groups", {})).toEqual({
    groups: [compactYouth],
  });
  expect(await ok(client, "ct_search_groups", {})).toEqual({
    groups: [compactYouth],
  });
});

test.each([
  { query: "Y" },
  { query: "  Y  " },
  { limit: 0 },
  { limit: 201 },
  { page: 0 },
  { group_type_ids: [0] },
  { group_status_ids: [1.5] },
  { group_status_ids: ["1"] },
])("search rejects %j without a request", async (args) => {
  const { client, calls } = await ready([]);

  await fails(client, "ct_search_groups", args);

  expect(calls).toHaveLength(0);
});

test("search answered without a data list is a clear error that does not echo the body", async () => {
  const { client } = await ready([json({ groups: cookieValue })]);

  const text = await fails(client, "ct_search_groups", {});

  expect(text).toContain("Unexpected answer from /groups");
});

// ct_get_group

test("get reads GET /groups/{id} and returns id, name, information and settings", async () => {
  const { client, requests } = await ready([json({ data: youth })]);

  const result = await ok(client, "ct_get_group", { groupId: 5 });

  expect(result).toEqual({
    id: 5,
    name: "Youth",
    information: youth.information,
    settings: youth.settings,
  });
  expect(requests()).toEqual([`GET ${api}/groups/5`]);
});

test("get of an unknown group reports the server's message, not the raw body", async () => {
  const { client } = await ready([
    new Response(`<html>${cookieValue}</html>`, { status: 404 }),
    json({ message: "Group not found" }, { status: 404 }),
  ]);

  expect(await fails(client, "ct_get_group", { groupId: 99 })).toContain(
    "HTTP 404",
  );
  expect(await fails(client, "ct_get_group", { groupId: 99 })).toContain(
    "Group not found",
  );
});

// ct_list_group_members

test("list members sends role ids, statuses, query, page and limit to GET /groups/{id}/members", async () => {
  const { client, calls, requests } = await ready([
    json({ data: [], meta: { pagination } }),
  ]);

  await ok(client, "ct_list_group_members", {
    groupId: 5,
    role_ids: [8, 9],
    group_member_statuses: ["active", "waiting"],
    query: "Ben",
    page: 2,
    limit: 100,
  });

  expect(requests()).toEqual([
    expect.stringMatching(`^GET ${api}/groups/5/members\\?`),
  ]);
  const sent = query(calls[0]?.path ?? "");
  expect(sent.getAll("role_ids[]")).toEqual(["8", "9"]);
  expect(sent.getAll("group_member_statuses[]")).toEqual(["active", "waiting"]);
  expect(sent.get("query")).toBe("Ben");
  expect(sent.get("page")).toBe("2");
  expect(sent.get("limit")).toBe("100");
});

test("list members returns person id, name, role and status of each member, plus the pagination", async () => {
  const { client } = await ready([json({ data: [ben], meta: { pagination } })]);

  const result = await ok(client, "ct_list_group_members", { groupId: 5 });

  expect(result).toEqual({ members: [compactBen], pagination });
});

test("list members without meta returns the members only", async () => {
  const { client } = await ready([json({ data: [ben] })]);

  expect(await ok(client, "ct_list_group_members", { groupId: 5 })).toEqual({
    members: [compactBen],
  });
});

test.each([
  { groupId: 5, group_member_statuses: ["gone"] },
  { groupId: 5, role_ids: [0] },
  { groupId: 5, limit: 201 },
  {},
])("list members rejects %j without a request", async (args) => {
  const { client, calls } = await ready([]);

  await fails(client, "ct_list_group_members", args);

  expect(calls).toHaveLength(0);
});

// Ids

const badIds = [0, -1, 1.5, "5", null];
const idTools: [string, string, Record<string, unknown>][] = [
  ["ct_get_group", "groupId", {}],
  ["ct_list_group_members", "groupId", {}],
  ["ct_update_group", "groupId", { fields: { note: "x" } }],
  ["ct_delete_group", "groupId", {}],
  ["ct_add_group_member", "groupId", { personId: 12 }],
  ["ct_add_group_member", "personId", { groupId: 5 }],
  [
    "ct_update_group_member",
    "groupId",
    { personId: 12, groupMemberStatus: "waiting" },
  ],
  ["ct_remove_group_member", "personId", { groupId: 5 }],
  ["ct_add_group_member", "groupTypeRoleId", { groupId: 5, personId: 12 }],
  ["ct_create_group", "groupTypeId", { name: "A", groupStatusId: 1 }],
  ["ct_create_group", "groupStatusId", { name: "A", groupTypeId: 1 }],
];

test.each(
  idTools.flatMap(([tool, key, args]) =>
    badIds.map((id) => [tool, key, args, id]),
  ),
)("%s rejects %s %j without a request", async (tool, key, args, id) => {
  const { client, calls } = await ready([]);

  await fails(client, tool as string, {
    ...(args as object),
    [key as string]: id,
  });

  expect(calls).toHaveLength(0);
});

// Session

const everyTool: [string, Record<string, unknown>][] = [
  ["ct_search_groups", {}],
  ["ct_get_group", { groupId: 5 }],
  ["ct_list_group_members", { groupId: 5 }],
  ["ct_create_group", { name: "A", groupTypeId: 1, groupStatusId: 1 }],
  ["ct_update_group", { groupId: 5, fields: { note: "x" } }],
  ["ct_delete_group", { groupId: 5 }],
  ["ct_add_group_member", { groupId: 5, personId: 12 }],
  [
    "ct_update_group_member",
    { groupId: 5, personId: 12, groupMemberStatus: "waiting" },
  ],
  ["ct_remove_group_member", { groupId: 5, personId: 12 }],
];

test("without a login every group tool asks for the 2FA code and sends nothing", async () => {
  const { fetch, calls } = fakeFetch();
  const client = await connectClient(fetch);

  for (const [tool, args] of everyTool) {
    expect(await fails(client, tool, args)).toContain(loginRequired);
  }
  expect(calls).toHaveLength(0);
});

test.each(everyTool.filter(([tool]) => tool !== "ct_create_group"))(
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

// ct_create_group

test("create previews exactly the fields it posts and writes nothing before ct_execute_plan", async () => {
  const { client, calls, requests } = await ready([json({ data: youth })]);

  const p = await plan(client, "ct_create_group", {
    name: "Youth",
    groupTypeId: 1,
    groupStatusId: 1,
    fields: { campusId: 2, note: null },
  });

  expect(requests()).toEqual([]);
  expect(p.preview.summary).toBe("Create group Youth");
  expect(p.preview.changes).toEqual([
    {
      method: "POST",
      path: "/groups",
      fields: {
        campusId: { after: 2 },
        note: { after: null },
        name: { after: "Youth" },
        groupTypeId: { after: 1 },
        groupStatusId: { after: 1 },
      },
    },
  ]);

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(requests()).toEqual([`POST ${api}/groups`]);
  expect(calls[0]?.body).toEqual({
    campusId: 2,
    note: null,
    name: "Youth",
    groupTypeId: 1,
    groupStatusId: 1,
  });
});

test.each([
  { groupTypeId: 1, groupStatusId: 1 },
  { name: "A", groupStatusId: 1 },
  { name: "A", groupTypeId: 1 },
  { name: "  ", groupTypeId: 1, groupStatusId: 1 },
])("create rejects %j without a request", async (args) => {
  const { client, calls } = await ready([]);

  await fails(client, "ct_create_group", args);

  expect(calls).toHaveLength(0);
});

// ct_update_group

test("update previews before and after of the changed fields only, flat field names read from information and settings", async () => {
  const { client, requests } = await ready([json({ data: youth })]);

  const p = await plan(client, "ct_update_group", {
    groupId: 5,
    fields: {
      name: "Youth Nord",
      note: "Saturdays",
      weekday: 5,
      visibility: "public",
      campusId: null,
    },
  });

  expect(p.preview.summary).toBe("Update group 5 (Youth)");
  expect(p.preview.changes).toEqual([
    {
      method: "PATCH",
      path: "/groups/5",
      fields: {
        name: { before: "Youth", after: "Youth Nord" },
        note: { before: "Fridays", after: "Saturdays" },
        visibility: { before: "intern", after: "public" },
      },
    },
  ]);
  expect(requests()).toEqual([`GET ${api}/groups/5`]);
});

test("executing an update re-reads the group, then patches only the changed fields", async () => {
  const { client, calls, requests } = await ready([
    json({ data: youth }),
    json({ data: youth }),
    json({ data: youth }),
  ]);
  const p = await plan(client, "ct_update_group", {
    groupId: 5,
    fields: { note: "Saturdays", groupTypeId: 1 },
  });

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(requests()).toEqual([
    `GET ${api}/groups/5`,
    `GET ${api}/groups/5`,
    `PATCH ${api}/groups/5`,
  ]);
  expect(calls[2]?.body).toEqual({ note: "Saturdays" });
});

test("a group changed since the preview aborts the update with zero writes", async () => {
  const { client, writes } = await ready([
    json({ data: youth }),
    json({ data: { ...youth, name: "Teens" } }),
  ]);
  const p = await plan(client, "ct_update_group", {
    groupId: 5,
    fields: { note: "Saturdays" },
  });

  const text = await fails(client, "ct_execute_plan", { token: p.token });

  expect(text).toContain("Nothing was written");
  expect(text).toContain("name");
  expect(writes()).toHaveLength(0);
});

test("an update that changes nothing is a clear error and makes no plan", async () => {
  const { client } = await ready([json({ data: youth })]);

  const text = await fails(client, "ct_update_group", {
    groupId: 5,
    fields: { note: "Fridays", name: "Youth" },
  });

  expect(text).toContain("No change");
  expect(text).not.toContain("token");
});

test("an update without fields is rejected without a request", async () => {
  const { client, calls } = await ready([]);

  await fails(client, "ct_update_group", { groupId: 5, fields: {} });

  expect(calls).toHaveLength(0);
});

// ct_delete_group

test("delete previews the whole group, names it and writes nothing", async () => {
  const { client, requests } = await ready([json({ data: youth })]);

  const p = await plan(client, "ct_delete_group", { groupId: 5 });

  expect(p.preview.summary).toBe("Delete group 5 (Youth)");
  expect(p.preview.changes).toEqual([
    { method: "DELETE", path: "/groups/5", record: youth },
  ]);
  expect(requests()).toEqual([`GET ${api}/groups/5`]);
});

test("executing a delete re-reads the group, then deletes it without a body or query", async () => {
  const { client, calls, requests } = await ready([
    json({ data: youth }),
    json({ data: youth }),
    new Response(null, { status: 204 }),
  ]);
  const p = await plan(client, "ct_delete_group", { groupId: 5 });

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(requests()).toEqual([
    `GET ${api}/groups/5`,
    `GET ${api}/groups/5`,
    `DELETE ${api}/groups/5`,
  ]);
  expect(calls[2]?.body).toBeUndefined();
});

// ct_add_group_member

test("adding an existing member is an error from the preview, not a plan", async () => {
  const { client, requests } = await ready([json({ data: ben })]);

  const text = await fails(client, "ct_add_group_member", {
    groupId: 5,
    personId: 12,
  });

  expect(text).toContain("already a member");
  expect(text).toContain("ct_update_group_member");
  expect(text).not.toContain("token");
  expect(requests()).toEqual([`GET ${api}/groups/5/members/12`]);
});

test("add previews the PUT body of a new membership and writes nothing", async () => {
  const { client, requests } = await ready([notFound()]);

  const p = await plan(client, "ct_add_group_member", {
    groupId: 5,
    personId: 12,
    groupTypeRoleId: 8,
    groupMemberStatus: "active",
    comment: "from the youth camp",
    memberStartDate: "2026-10-01",
  });

  expect(p.preview.summary).toBe("Add person 12 to group 5");
  expect(p.preview.changes).toEqual([
    {
      method: "PUT",
      path: "/groups/5/members/12",
      fields: {
        groupTypeRoleId: { after: 8 },
        groupMemberStatus: { after: "active" },
        comment: { after: "from the youth camp" },
        memberStartDate: { after: "2026-10-01" },
      },
    },
  ]);
  expect(requests()).toEqual([`GET ${api}/groups/5/members/12`]);
});

test("the add plan carries an absent guard: a member added since the preview aborts with zero writes", async () => {
  const { client, writes } = await ready([notFound(), json({ data: ben })]);
  const p = await plan(client, "ct_add_group_member", {
    groupId: 5,
    personId: 12,
  });

  const text = await fails(client, "ct_execute_plan", { token: p.token });

  expect(text).toContain("Nothing was written");
  expect(text).toContain("exists now");
  expect(writes()).toHaveLength(0);
});

test("executing an add re-reads the membership as absent, then puts the previewed body", async () => {
  const { client, calls, requests } = await ready([
    notFound(),
    notFound(),
    json({ data: ben }),
  ]);
  const p = await plan(client, "ct_add_group_member", {
    groupId: 5,
    personId: 12,
    groupTypeRoleId: 8,
  });

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(requests()).toEqual([
    `GET ${api}/groups/5/members/12`,
    `GET ${api}/groups/5/members/12`,
    `PUT ${api}/groups/5/members/12`,
  ]);
  expect(calls[2]?.body).toEqual({ groupTypeRoleId: 8 });
});

// ct_update_group_member

test("update member previews before and after of the changed fields only", async () => {
  const { client, requests } = await ready([json({ data: ben })]);

  const p = await plan(client, "ct_update_group_member", {
    groupId: 5,
    personId: 12,
    groupTypeRoleId: 9,
    groupMemberStatus: "active",
    comment: "moved up",
    memberEndDate: "2026-12-31",
  });

  expect(p.preview.summary).toBe(
    "Update the membership of person 12 (Ben Berg) in group 5 (Youth)",
  );
  expect(p.preview.changes).toEqual([
    {
      method: "PATCH",
      path: "/groups/5/members/12",
      fields: {
        groupTypeRoleId: { before: 8, after: 9 },
        comment: { before: null, after: "moved up" },
        memberEndDate: { before: null, after: "2026-12-31" },
      },
    },
  ]);
  expect(requests()).toEqual([`GET ${api}/groups/5/members/12`]);
});

test("executing a member update re-reads the membership, then patches only the changed fields", async () => {
  const { client, calls, requests } = await ready([
    json({ data: ben }),
    json({ data: ben }),
    json({ data: { ...ben, groupMemberStatus: "waiting" } }),
  ]);
  const p = await plan(client, "ct_update_group_member", {
    groupId: 5,
    personId: 12,
    groupMemberStatus: "waiting",
  });

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(requests()).toEqual([
    `GET ${api}/groups/5/members/12`,
    `GET ${api}/groups/5/members/12`,
    `PATCH ${api}/groups/5/members/12`,
  ]);
  expect(calls[2]?.body).toEqual({ groupMemberStatus: "waiting" });
});

test("a membership changed since the preview aborts the update with zero writes", async () => {
  const { client, writes } = await ready([
    json({ data: ben }),
    json({ data: { ...ben, groupTypeRoleId: 9 } }),
  ]);
  const p = await plan(client, "ct_update_group_member", {
    groupId: 5,
    personId: 12,
    comment: "x",
  });

  const text = await fails(client, "ct_execute_plan", { token: p.token });

  expect(text).toContain("groupTypeRoleId");
  expect(writes()).toHaveLength(0);
});

test("a member update without any change named is rejected without a request", async () => {
  const { client, calls } = await ready([]);

  const text = await fails(client, "ct_update_group_member", {
    groupId: 5,
    personId: 12,
  });

  expect(text).toContain("at least one");
  expect(calls).toHaveLength(0);
});

test("a member update that changes nothing is a clear error and makes no plan", async () => {
  const { client } = await ready([json({ data: ben })]);

  const text = await fails(client, "ct_update_group_member", {
    groupId: 5,
    personId: 12,
    groupMemberStatus: "active",
  });

  expect(text).toContain("No change");
});

// ct_remove_group_member

test("remove previews the whole membership, names person and group, and writes nothing", async () => {
  const { client, requests } = await ready([json({ data: ben })]);

  const p = await plan(client, "ct_remove_group_member", {
    groupId: 5,
    personId: 12,
  });

  expect(p.preview.summary).toBe(
    "Remove person 12 (Ben Berg) from group 5 (Youth)",
  );
  expect(p.preview.changes).toEqual([
    { method: "DELETE", path: "/groups/5/members/12", record: ben },
  ]);
  expect(requests()).toEqual([`GET ${api}/groups/5/members/12`]);
});

test("executing a remove re-reads the membership, then deletes it without a body", async () => {
  const { client, calls, requests } = await ready([
    json({ data: ben }),
    json({ data: ben }),
    new Response(null, { status: 204 }),
  ]);
  const p = await plan(client, "ct_remove_group_member", {
    groupId: 5,
    personId: 12,
  });

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(requests()).toEqual([
    `GET ${api}/groups/5/members/12`,
    `GET ${api}/groups/5/members/12`,
    `DELETE ${api}/groups/5/members/12`,
  ]);
  expect(calls[2]?.body).toBeUndefined();
});

test.each([
  ["ct_update_group_member", { comment: "x" }],
  ["ct_remove_group_member", {}],
])(
  "%s of a person who is no member is an error and makes no plan",
  async (tool, args) => {
    const { client } = await ready([notFound()]);

    const text = await fails(client, tool, {
      groupId: 5,
      personId: 12,
      ...args,
    });

    expect(JSON.parse(text)).toMatchObject({
      error: "Group member not found",
      status: 404,
    });
  },
);
