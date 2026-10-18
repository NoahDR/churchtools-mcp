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

async function connectClient(fetch: typeof globalThis.fetch) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await createServer({ env, fetch }).connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}
async function ready(answers: (Response | Error)[] = []) {
  const { fetch, calls } = fakeFetch(...loginAnswers(), ...answers);
  const client = await connectClient(fetch);
  await call(client, "ct_login", { code });
  calls.splice(0);
  return { client, calls };
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

test.each([
  ["ct_get_song", { songId: -1 }],
  ["ct_get_song", { songId: 0 }],
  ["ct_get_person_absence", { personId: "7/../../persons", absenceId: 1 }],
  ["ct_get_wiki_page", { wikiCategoryId: 1, identifier: "../persons" }],
  ["ct_get_wiki_page", { wikiCategoryId: 1, identifier: ".." }],
  ["ct_list_files", { domainType: "person", domainIdentifier: ".." }],
  ["ct_list_tags", { domainType: "person/7" }],
  ["ct_list_tags", { domainType: "Finance" }],
  [
    "ct_answer_meeting_request",
    {
      calendarId: 1,
      appointmentId: 2,
      meetingRequestId: 3,
      answer: "../accept",
    },
  ],
  ["ct_answer_booking", { bookingId: 1, answer: "delete" }],
  ["ct_create_song", { fields: {} }],
  ["ct_update_absence", { personId: 7, absenceId: 1, fields: {} }],
  ["ct_postpone_followup", { followUpId: 1, dueDate: "01.12.2026" }],
  ["ct_list_bookings", { resource_ids: [] }],
  ["ct_search_wiki", { query: "   " }],
])("%s rejects %j before any request", async (name, args) => {
  const { client, calls } = await ready();
  const { isError } = await call(client, name, args);
  expect(isError).toBe(true);
  expect(calls).toHaveLength(0);
});

test("no forbidden tool is registered: no finance, no check-in creation, no signup/token, no login-token/password/2FA/merge, no post sending", async () => {
  const { fetch } = fakeFetch();
  const client = await connectClient(fetch);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const name of names) {
    expect(name).not.toMatch(/finance|donation|spende/i);
    expect(name).not.toMatch(
      /logintoken|loginstring|password|twofactor|merge/i,
    );
    expect(name).not.toMatch(/signup|token/i);
  }
  expect(names).not.toContain("ct_create_checkin_person");
  expect(names).not.toContain("ct_checkin_person");
  expect(names).not.toContain("ct_send_post");
  expect(names).not.toContain("ct_create_post");
  // Every new write is a plan tool (non-read-only); the only destructive one stays ct_execute_plan.
  const destructive = tools
    .filter((t) => t.annotations?.destructiveHint)
    .map((t) => t.name);
  expect(destructive).toEqual(["ct_execute_plan"]);
});

test("a server error on a new read does not echo secrets", async () => {
  const { client } = await ready([
    json({ message: "kaputt" }, { status: 400 }),
  ]);
  const { isError, text } = await call(client, "ct_get_song", { songId: 9 });
  expect(isError).toBe(true);
  expect(text).toContain("kaputt");
});

test("a plan tool refuses a record that changed shape (no data envelope) instead of planning unguarded", async () => {
  const { client, calls } = await ready([json({ unexpected: true })]);
  const { isError } = await call(client, "ct_delete_song", { songId: 9 });
  expect(isError).toBe(true);
  expect(calls.every((c) => c.method === "GET")).toBe(true);
});
