import { readFileSync } from "node:fs";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, test } from "vitest";
import { PlanError } from "../src/plans.js";
import { createServer } from "../src/server.js";
import { toolResult } from "../src/tools/result.js";
import {
  code,
  env,
  fakeFetch,
  json,
  loginAnswers,
  secrets,
} from "./fake-fetch.js";

async function connectClient(
  deps: Parameters<typeof createServer>[0],
): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await createServer(deps).connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [content] = result.content as { type: string; text: string }[];
  return { isError: result.isError ?? false, text: content?.text ?? "" };
}

function expectNoSecrets(text: string): void {
  for (const secret of secrets) expect(text).not.toContain(secret);
}

test("the server offers the session, plan, generic, person, group, calendar and event tools", async () => {
  const client = await connectClient({ env, fetch: fakeFetch().fetch });

  const { tools } = await client.listTools();

  expect(tools.map((tool) => tool.name).sort()).toEqual([
    "ct_add_group_member",
    "ct_api_request",
    "ct_assign_event_service",
    "ct_create_appointment",
    "ct_create_group",
    "ct_create_person",
    "ct_delete_appointment",
    "ct_delete_event",
    "ct_delete_group",
    "ct_delete_person",
    "ct_execute_plan",
    "ct_get_appointment",
    "ct_get_event",
    "ct_get_group",
    "ct_get_operation",
    "ct_get_person",
    "ct_list_appointments",
    "ct_list_calendars",
    "ct_list_events",
    "ct_list_group_members",
    "ct_list_services",
    "ct_login",
    "ct_remove_group_member",
    "ct_search_api",
    "ct_search_groups",
    "ct_search_persons",
    "ct_set_external_event_service",
    "ct_status",
    "ct_update_appointment",
    "ct_update_event",
    "ct_update_group",
    "ct_update_group_member",
    "ct_update_person",
  ]);
});

test("every read tool is read-only, every write tool returns a plan and only ct_execute_plan is destructive", async () => {
  const read = { readOnlyHint: true, openWorldHint: true };
  const plan = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  };
  const reads = [
    "ct_status",
    "ct_search_api",
    "ct_get_operation",
    "ct_search_persons",
    "ct_get_person",
    "ct_search_groups",
    "ct_get_group",
    "ct_list_group_members",
    "ct_list_calendars",
    "ct_list_appointments",
    "ct_get_appointment",
    "ct_list_events",
    "ct_get_event",
    "ct_list_services",
  ];
  const plans = [
    "ct_api_request",
    "ct_create_person",
    "ct_update_person",
    "ct_delete_person",
    "ct_create_group",
    "ct_update_group",
    "ct_delete_group",
    "ct_add_group_member",
    "ct_update_group_member",
    "ct_remove_group_member",
    "ct_create_appointment",
    "ct_update_appointment",
    "ct_delete_appointment",
    "ct_update_event",
    "ct_delete_event",
    "ct_assign_event_service",
    "ct_set_external_event_service",
  ];
  const client = await connectClient({ env, fetch: fakeFetch().fetch });

  const { tools } = await client.listTools();

  expect(
    Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations])),
  ).toEqual({
    ...Object.fromEntries(reads.map((name) => [name, read])),
    ...Object.fromEntries(plans.map((name) => [name, plan])),
    ct_login: { readOnlyHint: false, openWorldHint: true },
    ct_execute_plan: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  });
});

test("the server reports its name and the package.json version", async () => {
  const { version } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  const client = await connectClient({ env, fetch: fakeFetch().fetch });

  expect(client.getServerVersion()).toMatchObject({
    name: "churchtools-mcp",
    version,
  });
});

test("ct_login logs in and returns the user as JSON text", async () => {
  const { fetch } = fakeFetch(...loginAnswers());
  const client = await connectClient({ env, fetch });

  const { isError, text } = await call(client, "ct_login", { code });

  expect(isError).toBe(false);
  expect(JSON.parse(text)).toEqual({
    state: "ready",
    personId: 7,
    name: "Anna Admin",
  });
  expectNoSecrets(text);
});

test.each(["12345", "1234567", "12345a", " 123456", "１２３４５６"])(
  "ct_login rejects the code %j before any request",
  async (badCode) => {
    const { fetch, calls } = fakeFetch();
    const client = await connectClient({ env, fetch });

    const { isError, text } = await call(client, "ct_login", {
      code: badCode,
    });

    expect(isError).toBe(true);
    expect(text).not.toContain(badCode.trim());
    expect(calls).toHaveLength(0);
  },
);

test("a wrong code is an error result with the server message, and the status says logged_out", async () => {
  const [login] = loginAnswers();
  const { fetch } = fakeFetch(
    login,
    json({ message: "Invalid code" }, { status: 401 }),
    json({ version: "3.137.1", build: "1", siteName: "Demo" }),
  );
  const client = await connectClient({ env, fetch });

  const login1 = await call(client, "ct_login", { code });
  const status = await call(client, "ct_status");

  expect(login1.isError).toBe(true);
  expect(login1.text).toContain("Invalid code");
  expectNoSecrets(login1.text);
  expect(JSON.parse(status.text)).toMatchObject({ state: "logged_out" });
});

test("with an invalid configuration the server starts and both tools name the variable", async () => {
  const { fetch, calls } = fakeFetch();
  const client = await connectClient({
    env: { CT_URL: "http://example.org", CT_USERNAME: "admin" },
    fetch,
  });

  const login = await call(client, "ct_login", { code });
  const status = await call(client, "ct_status");

  expect(login.isError).toBe(true);
  expect(login.text).toContain("CT_URL must be an https URL");
  expect(login.text).toContain("CT_PASSWORD is missing");
  expect(JSON.parse(status.text)).toMatchObject({
    configValid: false,
    state: "logged_out",
  });
  expect(status.text).toContain("CT_PASSWORD is missing");
  expect(calls).toHaveLength(0);
});

test("ct_status of a ready session is JSON text without secrets", async () => {
  const { fetch } = fakeFetch(
    ...loginAnswers(),
    json({ version: "3.137.1", build: "1", siteName: "Demo" }),
  );
  const client = await connectClient({ env, fetch });
  await call(client, "ct_login", { code });

  const { isError, text } = await call(client, "ct_status");

  expect(isError).toBe(false);
  expect(JSON.parse(text)).toMatchObject({
    configValid: true,
    state: "ready",
    name: "Anna Admin",
    instance: { version: "3.137.1", build: "1", siteName: "Demo" },
  });
  expectNoSecrets(text);
});

test("an unreachable instance shows in ct_status as instance.error, not as an error result", async () => {
  const fetch: typeof globalThis.fetch = () =>
    Promise.reject(new TypeError("fetch failed"));
  const client = await connectClient({ env, fetch });

  const { isError, text } = await call(client, "ct_status");

  expect(isError).toBe(false);
  expect(JSON.parse(text)).toEqual({
    configValid: true,
    state: "logged_out",
    instance: { error: "cannot reach example.org: fetch failed" },
  });
});

// ct_execute_plan

test("ct_execute_plan is announced as destructive", async () => {
  const client = await connectClient({ env, fetch: fakeFetch().fetch });

  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "ct_execute_plan");

  expect(tool?.annotations).toMatchObject({
    destructiveHint: true,
    readOnlyHint: false,
  });
});

test("a fresh server knows no plan: any token is an error result without a request", async () => {
  const { fetch, calls } = fakeFetch(...loginAnswers());
  const client = await connectClient({ env, fetch });
  await call(client, "ct_login", { code });
  calls.splice(0);

  const { isError, text } = await call(client, "ct_execute_plan", {
    token: crypto.randomUUID(),
  });

  expect(isError).toBe(true);
  expect(text).toContain("unknown, expired or already used");
  expect(calls).toHaveLength(0);
});

test.each(["", "not-a-uuid", "123e4567-e89b-12d3-a456-42661417400"])(
  "ct_execute_plan rejects the malformed token %j without a request",
  async (token) => {
    const { fetch, calls } = fakeFetch();
    const client = await connectClient({ env, fetch });

    const { isError } = await call(client, "ct_execute_plan", { token });

    expect(isError).toBe(true);
    expect(calls).toHaveLength(0);
  },
);

test("an error result carries the details of a PlanError as JSON fields", async () => {
  const result = await toolResult(() =>
    Promise.reject(
      new PlanError("Change 1 of 1 failed", {
        args: { duplicatePersonId: 42 },
      }),
    ),
  );

  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
    error: "Change 1 of 1 failed",
    args: { duplicatePersonId: 42 },
  });
});
