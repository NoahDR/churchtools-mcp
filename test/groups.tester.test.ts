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

const youth = {
  id: 5,
  name: "Youth",
  information: { groupTypeId: 1, groupStatusId: 1, note: "Fridays" },
  settings: { visibility: "intern" },
  memberStatistics: { total: 3 },
};
const ben = {
  id: 70,
  personId: 12,
  groupTypeRoleId: 8,
  groupMemberStatus: "active",
  comment: null,
  memberStartDate: "2024-01-01",
  memberEndDate: null,
  person: { title: "Ben Berg" },
  group: { title: "Youth" },
};
const notFound = () =>
  json({ message: "Group member not found" }, { status: 404 });
const statuses = ["active", "requested", "waiting", "to_delete"];

async function connectClient(fetch: typeof globalThis.fetch) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await createServer({ env, fetch }).connect(serverTransport);
  const client = new Client({ name: "tester-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function ready(answers: (Response | Error)[]) {
  const { fetch, calls } = fakeFetch(...loginAnswers(), ...answers);
  const client = await connectClient(fetch);
  await call(client, "ct_login", { code });
  calls.splice(0);
  const writes = () => calls.filter((c) => c.method !== "GET");
  return { client, calls, writes };
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
    changes: {
      fields?: Record<string, { before?: unknown; after: unknown }>;
      record?: unknown;
    }[];
  };
}

async function plan(client: Client, name: string, args: unknown) {
  return (await ok(client, name, args)) as unknown as Plan;
}

const afterValues = (p: Plan) =>
  Object.fromEntries(
    Object.entries(p.preview.changes[0]?.fields ?? {}).map(([k, v]) => [
      k,
      v.after,
    ]),
  );

// Membership races

test("two add plans for one person: the second aborts after the first one added the member", async () => {
  const { client, writes } = await ready([
    notFound(),
    notFound(),
    notFound(),
    json({ data: ben }),
    json({ data: ben }),
  ]);
  const first = await plan(client, "ct_add_group_member", {
    groupId: 5,
    personId: 12,
  });
  const second = await plan(client, "ct_add_group_member", {
    groupId: 5,
    personId: 12,
    groupTypeRoleId: 9,
  });

  await ok(client, "ct_execute_plan", { token: first.token });
  const text = await fails(client, "ct_execute_plan", {
    token: second.token,
  });

  expect(text).toContain("exists now");
  expect(writes()).toHaveLength(1);
});

test("a member update whose membership was removed since the preview writes nothing", async () => {
  const { client, writes } = await ready([json({ data: ben }), notFound()]);
  const p = await plan(client, "ct_update_group_member", {
    groupId: 5,
    personId: 12,
    groupMemberStatus: "waiting",
  });

  const text = await fails(client, "ct_execute_plan", { token: p.token });

  expect(text).toContain("Nothing was written");
  expect(text).toContain("no longer exists");
  expect(writes()).toHaveLength(0);
});

test("an add whose person was added and removed again since the preview still puts the previewed body", async () => {
  const { client, calls } = await ready([
    notFound(),
    notFound(),
    json({ data: ben }),
  ]);
  const p = await plan(client, "ct_add_group_member", {
    groupId: 5,
    personId: 12,
    groupMemberStatus: "waiting",
  });

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(calls[2]?.method).toBe("PUT");
  expect(calls[2]?.body).toEqual(afterValues(p));
});

// Role and status values

test.each(statuses)(
  "add with status %s puts exactly that status, as previewed",
  async (status) => {
    const { client, calls } = await ready([
      notFound(),
      notFound(),
      json({ data: ben }),
    ]);
    const p = await plan(client, "ct_add_group_member", {
      groupId: 5,
      personId: 12,
      groupTypeRoleId: 2147483647,
      groupMemberStatus: status,
    });

    await ok(client, "ct_execute_plan", { token: p.token });

    expect(calls[2]?.body).toEqual({
      groupTypeRoleId: 2147483647,
      groupMemberStatus: status,
    });
    expect(calls[2]?.body).toEqual(afterValues(p));
  },
);

test.each(statuses.filter((s) => s !== "active"))(
  "member update from active to %s patches only the status",
  async (status) => {
    const { client, calls } = await ready([
      json({ data: ben }),
      json({ data: ben }),
      json({ data: ben }),
    ]);
    const p = await plan(client, "ct_update_group_member", {
      groupId: 5,
      personId: 12,
      groupMemberStatus: status,
      groupTypeRoleId: 8,
    });

    await ok(client, "ct_execute_plan", { token: p.token });

    expect(p.preview.changes[0]?.fields).toEqual({
      groupMemberStatus: { before: "active", after: status },
    });
    expect(calls[2]?.body).toEqual({ groupMemberStatus: status });
  },
);

test.each([
  { groupMemberStatus: "Active" },
  { groupMemberStatus: "inactive" },
  { groupMemberStatus: "" },
  { groupTypeRoleId: 0 },
  { groupTypeRoleId: "8" },
])("member update rejects %j without a request", async (args) => {
  const { client, calls } = await ready([]);

  await fails(client, "ct_update_group_member", {
    groupId: 5,
    personId: 12,
    ...args,
  });

  expect(calls).toHaveLength(0);
});

test("an add without optional fields previews an empty body and puts an empty JSON object", async () => {
  const { client, calls } = await ready([
    notFound(),
    notFound(),
    json({ data: ben }),
  ]);
  const p = await plan(client, "ct_add_group_member", {
    groupId: 5,
    personId: 12,
  });

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(p.preview.changes[0]?.fields).toEqual({});
  expect(calls[2]?.body).toEqual({});
});

// Odd group nesting

test.each([
  ["missing", { id: 5, name: "Youth" }],
  ["null", { id: 5, name: "Youth", information: null, settings: null }],
  ["empty PHP arrays", { id: 5, name: "Youth", information: [], settings: [] }],
])(
  "get of a group with information and settings %s returns the group",
  async (_kind, group) => {
    const { client } = await ready([json({ data: group })]);

    const result = await ok(client, "ct_get_group", { groupId: 5 });

    expect(result).toMatchObject({ id: 5, name: "Youth" });
  },
);

test.each([
  ["missing", { id: 5, name: "Youth" }],
  ["null", { id: 5, name: "Youth", information: null, settings: null }],
  ["empty PHP arrays", { id: 5, name: "Youth", information: [], settings: [] }],
])(
  "update of a group with information and settings %s patches the field as previewed",
  async (_kind, group) => {
    const { client, calls } = await ready([
      json({ data: group }),
      json({ data: group }),
      json({ data: group }),
    ]);
    const p = await plan(client, "ct_update_group", {
      groupId: 5,
      fields: { note: "Saturdays", visibility: "public" },
    });

    await ok(client, "ct_execute_plan", { token: p.token });

    expect(p.preview.changes[0]?.fields).toEqual({
      note: { before: "(absent)", after: "Saturdays" },
      visibility: { before: "(absent)", after: "public" },
    });
    expect(calls[2]?.body).toEqual({ note: "Saturdays", visibility: "public" });
  },
);

test("search lists a group whose information is an empty PHP array", async () => {
  const { client } = await ready([
    json({ data: [{ id: 6, name: "Bare", information: [] }] }),
  ]);

  const result = await ok(client, "ct_search_groups", {});

  expect(result).toEqual({ groups: [{ id: 6, name: "Bare" }] });
});

test("update of a nested-only field patches it flat and keeps information and settings out of the body", async () => {
  const { client, calls } = await ready([
    json({ data: youth }),
    json({ data: youth }),
    json({ data: youth }),
  ]);
  const p = await plan(client, "ct_update_group", {
    groupId: 5,
    fields: { groupStatusId: 3, visibility: "intern" },
  });

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(p.preview.changes[0]?.fields).toEqual({
    groupStatusId: { before: 1, after: 3 },
  });
  expect(calls[2]?.body).toEqual({ groupStatusId: 3 });
});

test("update never sends force, so a rename keeps ChurchTools' duplicate check", async () => {
  const { client, calls } = await ready([
    json({ data: youth }),
    json({ data: youth }),
    json({ data: youth }),
  ]);
  const p = await plan(client, "ct_update_group", {
    groupId: 5,
    fields: { name: "Teens", force: true },
  });

  await ok(client, "ct_execute_plan", { token: p.token });

  expect(calls[2]?.body).toEqual({ name: "Teens" });
});

// Delete of a group with members

test("a group delete whose member count changed since the preview writes nothing", async () => {
  const { client, writes } = await ready([
    json({ data: youth }),
    json({ data: { ...youth, memberStatistics: { total: 4 } } }),
  ]);
  const p = await plan(client, "ct_delete_group", { groupId: 5 });

  const text = await fails(client, "ct_execute_plan", { token: p.token });

  expect(p.preview.changes[0]?.record).toMatchObject({
    memberStatistics: { total: 3 },
  });
  expect(text).toContain("memberStatistics");
  expect(writes()).toHaveLength(0);
});

// Member paging and odd member records

test.each([1, 200])("list members accepts limit %i", async (limit) => {
  const { client, calls } = await ready([json({ data: [] })]);

  await ok(client, "ct_list_group_members", { groupId: 5, limit, page: 7 });

  const sent = new URL(calls[0]?.path ?? "", "https://x").searchParams;
  expect(sent.get("limit")).toBe(String(limit));
  expect(sent.get("page")).toBe("7");
});

test("list members passes a last page through unchanged", async () => {
  const pagination = { current: 3, lastPage: 3, limit: 10, total: 21 };
  const { client } = await ready([json({ data: [ben], meta: { pagination } })]);

  const result = await ok(client, "ct_list_group_members", {
    groupId: 5,
    page: 3,
  });

  expect(result.pagination).toEqual(pagination);
});

test.each(statuses)("list members filters by status %s", async (status) => {
  const { client, calls } = await ready([json({ data: [] })]);

  await ok(client, "ct_list_group_members", {
    groupId: 5,
    group_member_statuses: [status],
  });

  const sent = new URL(calls[0]?.path ?? "", "https://x").searchParams;
  expect(sent.getAll("group_member_statuses[]")).toEqual([status]);
});

test("list members keeps a member whose person has no title", async () => {
  const { client } = await ready([
    json({
      data: [
        { ...ben, person: { domainType: "person", title: null } },
        { ...ben, personId: 13, person: { domainType: "person" } },
      ],
    }),
  ]);

  const result = await ok(client, "ct_list_group_members", { groupId: 5 });

  expect(result.members).toEqual([
    { personId: 12, groupTypeRoleId: 8, groupMemberStatus: "active" },
    { personId: 13, groupTypeRoleId: 8, groupMemberStatus: "active" },
  ]);
});
