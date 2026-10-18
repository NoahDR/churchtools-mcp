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
    "ct_accept_exchange_request",
    "ct_accept_service_request",
    "ct_add_group_member",
    "ct_add_note",
    "ct_add_tag",
    "ct_answer_booking",
    "ct_answer_meeting_request",
    "ct_api_request",
    "ct_assign_event_service",
    "ct_check_booking_conflicts",
    "ct_complete_followup",
    "ct_create_absence",
    "ct_create_agenda_item",
    "ct_create_appointment",
    "ct_create_booking",
    "ct_create_exchange_request",
    "ct_create_fact",
    "ct_create_group",
    "ct_create_person",
    "ct_create_relationship",
    "ct_create_song",
    "ct_create_song_arrangement",
    "ct_create_tag",
    "ct_create_wiki_category",
    "ct_create_wiki_page",
    "ct_decline_exchange_request",
    "ct_decline_service_request",
    "ct_delete_absence",
    "ct_delete_agenda_item",
    "ct_delete_appointment",
    "ct_delete_booking",
    "ct_delete_event",
    "ct_delete_event_fact",
    "ct_delete_fact",
    "ct_delete_group",
    "ct_delete_note",
    "ct_delete_person",
    "ct_delete_relationship",
    "ct_delete_song",
    "ct_delete_song_arrangement",
    "ct_delete_tag",
    "ct_delete_wiki_category",
    "ct_delete_wiki_page",
    "ct_dismiss_followup",
    "ct_execute_plan",
    "ct_get_agenda_template",
    "ct_get_appointment",
    "ct_get_appointment_template",
    "ct_get_booking",
    "ct_get_event",
    "ct_get_event_agenda",
    "ct_get_event_fact",
    "ct_get_event_masterdata",
    "ct_get_fact",
    "ct_get_file_metadata",
    "ct_get_followup",
    "ct_get_group",
    "ct_get_group_homepage",
    "ct_get_group_meeting",
    "ct_get_internal_permission_origins",
    "ct_get_my_permissions",
    "ct_get_operation",
    "ct_get_permission_origins",
    "ct_get_person",
    "ct_get_person_absence",
    "ct_get_person_masterdata",
    "ct_get_person_service_request",
    "ct_get_post",
    "ct_get_public_group",
    "ct_get_public_group_form",
    "ct_get_qrcode_checkin",
    "ct_get_resource_masterdata",
    "ct_get_service",
    "ct_get_service_group",
    "ct_get_song",
    "ct_get_song_arrangement",
    "ct_get_wiki_page",
    "ct_hide_agenda_item",
    "ct_list_agenda_templates",
    "ct_list_appointment_templates",
    "ct_list_appointments",
    "ct_list_bookings",
    "ct_list_calendars",
    "ct_list_campuses",
    "ct_list_departments",
    "ct_list_event_agenda_songs",
    "ct_list_event_facts",
    "ct_list_events",
    "ct_list_exchange_candidates",
    "ct_list_exchange_requests",
    "ct_list_facts",
    "ct_list_files",
    "ct_list_followups",
    "ct_list_group_absences",
    "ct_list_group_followups",
    "ct_list_group_homepages",
    "ct_list_group_meeting_members",
    "ct_list_group_meetings",
    "ct_list_group_members",
    "ct_list_group_roles",
    "ct_list_meeting_requests",
    "ct_list_notes",
    "ct_list_object_permissions",
    "ct_list_object_tags",
    "ct_list_open_meeting_requests",
    "ct_list_permission_definitions",
    "ct_list_person_absences",
    "ct_list_person_followups",
    "ct_list_person_posts",
    "ct_list_person_service_requests",
    "ct_list_possible_persons",
    "ct_list_post_comments",
    "ct_list_posts",
    "ct_list_printers",
    "ct_list_relationship_types",
    "ct_list_relationships",
    "ct_list_security_levels",
    "ct_list_service_groups",
    "ct_list_services",
    "ct_list_song_arrangements",
    "ct_list_song_categories",
    "ct_list_song_sources",
    "ct_list_statuses",
    "ct_list_tags",
    "ct_list_wiki_categories",
    "ct_list_wiki_page_versions",
    "ct_list_wiki_pages",
    "ct_lock_agenda",
    "ct_login",
    "ct_postpone_followup",
    "ct_remove_group_member",
    "ct_remove_tag",
    "ct_search_api",
    "ct_search_groups",
    "ct_search_persons",
    "ct_search_posts",
    "ct_search_songs",
    "ct_search_wiki",
    "ct_set_default_arrangement",
    "ct_set_event_fact",
    "ct_set_external_event_service",
    "ct_status",
    "ct_undo_service_request",
    "ct_unhide_agenda_item",
    "ct_unlock_agenda",
    "ct_update_absence",
    "ct_update_agenda_item",
    "ct_update_appointment",
    "ct_update_booking",
    "ct_update_event",
    "ct_update_fact",
    "ct_update_group",
    "ct_update_group_member",
    "ct_update_note",
    "ct_update_person",
    "ct_update_service_request",
    "ct_update_song",
    "ct_update_song_arrangement",
    "ct_update_wiki_category",
    "ct_update_wiki_page",
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
    "ct_check_booking_conflicts",
    "ct_get_agenda_template",
    "ct_get_appointment",
    "ct_get_appointment_template",
    "ct_get_booking",
    "ct_get_event",
    "ct_get_event_agenda",
    "ct_get_event_fact",
    "ct_get_event_masterdata",
    "ct_get_fact",
    "ct_get_file_metadata",
    "ct_get_followup",
    "ct_get_group",
    "ct_get_group_homepage",
    "ct_get_group_meeting",
    "ct_get_internal_permission_origins",
    "ct_get_my_permissions",
    "ct_get_operation",
    "ct_get_permission_origins",
    "ct_get_person",
    "ct_get_person_absence",
    "ct_get_person_masterdata",
    "ct_get_person_service_request",
    "ct_get_post",
    "ct_get_public_group",
    "ct_get_public_group_form",
    "ct_get_qrcode_checkin",
    "ct_get_resource_masterdata",
    "ct_get_service",
    "ct_get_service_group",
    "ct_get_song",
    "ct_get_song_arrangement",
    "ct_get_wiki_page",
    "ct_list_agenda_templates",
    "ct_list_appointment_templates",
    "ct_list_appointments",
    "ct_list_bookings",
    "ct_list_calendars",
    "ct_list_campuses",
    "ct_list_departments",
    "ct_list_event_agenda_songs",
    "ct_list_event_facts",
    "ct_list_events",
    "ct_list_exchange_candidates",
    "ct_list_exchange_requests",
    "ct_list_facts",
    "ct_list_files",
    "ct_list_followups",
    "ct_list_group_absences",
    "ct_list_group_followups",
    "ct_list_group_homepages",
    "ct_list_group_meeting_members",
    "ct_list_group_meetings",
    "ct_list_group_members",
    "ct_list_group_roles",
    "ct_list_meeting_requests",
    "ct_list_notes",
    "ct_list_object_permissions",
    "ct_list_object_tags",
    "ct_list_open_meeting_requests",
    "ct_list_permission_definitions",
    "ct_list_person_absences",
    "ct_list_person_followups",
    "ct_list_person_posts",
    "ct_list_person_service_requests",
    "ct_list_possible_persons",
    "ct_list_post_comments",
    "ct_list_posts",
    "ct_list_printers",
    "ct_list_relationship_types",
    "ct_list_relationships",
    "ct_list_security_levels",
    "ct_list_service_groups",
    "ct_list_services",
    "ct_list_song_arrangements",
    "ct_list_song_categories",
    "ct_list_song_sources",
    "ct_list_statuses",
    "ct_list_tags",
    "ct_list_wiki_categories",
    "ct_list_wiki_page_versions",
    "ct_list_wiki_pages",
    "ct_search_api",
    "ct_search_groups",
    "ct_search_persons",
    "ct_search_posts",
    "ct_search_songs",
    "ct_search_wiki",
    "ct_status",
  ];
  const plans = [
    "ct_accept_exchange_request",
    "ct_accept_service_request",
    "ct_add_group_member",
    "ct_add_note",
    "ct_add_tag",
    "ct_answer_booking",
    "ct_answer_meeting_request",
    "ct_api_request",
    "ct_assign_event_service",
    "ct_complete_followup",
    "ct_create_absence",
    "ct_create_agenda_item",
    "ct_create_appointment",
    "ct_create_booking",
    "ct_create_exchange_request",
    "ct_create_fact",
    "ct_create_group",
    "ct_create_person",
    "ct_create_relationship",
    "ct_create_song",
    "ct_create_song_arrangement",
    "ct_create_tag",
    "ct_create_wiki_category",
    "ct_create_wiki_page",
    "ct_decline_exchange_request",
    "ct_decline_service_request",
    "ct_delete_absence",
    "ct_delete_agenda_item",
    "ct_delete_appointment",
    "ct_delete_booking",
    "ct_delete_event",
    "ct_delete_event_fact",
    "ct_delete_fact",
    "ct_delete_group",
    "ct_delete_note",
    "ct_delete_person",
    "ct_delete_relationship",
    "ct_delete_song",
    "ct_delete_song_arrangement",
    "ct_delete_tag",
    "ct_delete_wiki_category",
    "ct_delete_wiki_page",
    "ct_dismiss_followup",
    "ct_hide_agenda_item",
    "ct_lock_agenda",
    "ct_postpone_followup",
    "ct_remove_group_member",
    "ct_remove_tag",
    "ct_set_default_arrangement",
    "ct_set_event_fact",
    "ct_set_external_event_service",
    "ct_undo_service_request",
    "ct_unhide_agenda_item",
    "ct_unlock_agenda",
    "ct_update_absence",
    "ct_update_agenda_item",
    "ct_update_appointment",
    "ct_update_booking",
    "ct_update_event",
    "ct_update_fact",
    "ct_update_group",
    "ct_update_group_member",
    "ct_update_note",
    "ct_update_person",
    "ct_update_service_request",
    "ct_update_song",
    "ct_update_song_arrangement",
    "ct_update_wiki_category",
    "ct_update_wiki_page",
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
