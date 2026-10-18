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
async function ready(answers: (Response | Error)[]) {
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
async function ok(client: Client, name: string, args: unknown = {}) {
  const { isError, text } = await call(client, name, args);
  expect(isError, text).toBe(false);
  return JSON.parse(text) as {
    token: string;
    preview: {
      changes: { method: string; path: string }[];
      bookingConflicts?: unknown;
    };
    executed?: string;
    conflicts?: unknown;
    [key: string]: unknown;
  };
}
const guard = () =>
  json({ data: { id: 1, name: "Alt", title: "Alt", text: "Alt" } });

const reads: [string, Record<string, unknown>, string][] = [
  [
    "ct_get_event_agenda",
    {
      eventId: 5,
    },
    "/churchtools/api/events/5/agenda",
  ],
  [
    "ct_list_event_agenda_songs",
    {
      eventId: 5,
    },
    "/churchtools/api/events/5/agenda/songs",
  ],
  ["ct_list_agenda_templates", {}, "/churchtools/api/agendatemplates"],
  [
    "ct_get_agenda_template",
    {
      agendaId: 3,
    },
    "/churchtools/api/agendatemplates/3",
  ],
  [
    "ct_search_songs",
    {
      query: "Halleluja",
    },
    "/churchtools/api/songs?query=Halleluja",
  ],
  [
    "ct_get_song",
    {
      songId: 9,
    },
    "/churchtools/api/songs/9",
  ],
  [
    "ct_list_song_arrangements",
    {
      songId: 9,
    },
    "/churchtools/api/songs/9/arrangements",
  ],
  [
    "ct_get_song_arrangement",
    {
      songId: 9,
      arrangementId: 2,
    },
    "/churchtools/api/songs/9/arrangements/2",
  ],
  ["ct_list_song_categories", {}, "/churchtools/api/song/categories"],
  ["ct_list_song_sources", {}, "/churchtools/api/song/sources"],
  ["ct_list_service_groups", {}, "/churchtools/api/servicegroups"],
  [
    "ct_get_service_group",
    {
      serviceGroupId: 4,
    },
    "/churchtools/api/servicegroups/4",
  ],
  [
    "ct_get_service",
    {
      serviceId: 6,
    },
    "/churchtools/api/services/6",
  ],
  [
    "ct_list_possible_persons",
    {
      eventId: 5,
      serviceId: 6,
    },
    "/churchtools/api/events/5/services/6/possiblepersons",
  ],
  [
    "ct_list_person_service_requests",
    {
      personId: 7,
    },
    "/churchtools/api/persons/7/servicerequests",
  ],
  [
    "ct_get_person_service_request",
    {
      personId: 7,
      requestId: 8,
    },
    "/churchtools/api/persons/7/servicerequests/8",
  ],
  [
    "ct_list_exchange_requests",
    {
      personId: 7,
    },
    "/churchtools/api/persons/7/exchangerequests",
  ],
  [
    "ct_list_exchange_candidates",
    {
      personId: 7,
      eventId: 5,
      serviceId: 6,
    },
    "/churchtools/api/persons/7/events/5/services/6/exchangerequests/candidates",
  ],
  [
    "ct_list_person_absences",
    {
      personId: 7,
    },
    "/churchtools/api/persons/7/absences",
  ],
  [
    "ct_get_person_absence",
    {
      personId: 7,
      absenceId: 1,
    },
    "/churchtools/api/persons/7/absences/1",
  ],
  [
    "ct_list_group_absences",
    {
      groupId: 2,
    },
    "/churchtools/api/groups/2/absences",
  ],
  ["ct_get_resource_masterdata", {}, "/churchtools/api/resource/masterdata"],
  [
    "ct_list_bookings",
    {
      resource_ids: [3],
    },
    "/churchtools/api/bookings?resource_ids%5B%5D=3",
  ],
  [
    "ct_get_booking",
    {
      bookingId: 11,
    },
    "/churchtools/api/bookings/11",
  ],
  ["ct_get_person_masterdata", {}, "/churchtools/api/person/masterdata"],
  ["ct_get_event_masterdata", {}, "/churchtools/api/event/masterdata"],
  ["ct_list_departments", {}, "/churchtools/api/departments"],
  ["ct_list_statuses", {}, "/churchtools/api/statuses"],
  ["ct_list_campuses", {}, "/churchtools/api/campuses"],
  ["ct_list_group_roles", {}, "/churchtools/api/group/roles"],
  ["ct_list_facts", {}, "/churchtools/api/facts"],
  [
    "ct_get_fact",
    {
      factId: 1,
    },
    "/churchtools/api/facts/1",
  ],
  [
    "ct_list_event_facts",
    {
      eventId: 5,
    },
    "/churchtools/api/events/5/facts",
  ],
  [
    "ct_get_event_fact",
    {
      eventId: 5,
      factId: 1,
    },
    "/churchtools/api/events/5/facts/1",
  ],
  [
    "ct_list_group_meetings",
    {
      groupId: 2,
    },
    "/churchtools/api/groups/2/meetings",
  ],
  [
    "ct_get_group_meeting",
    {
      groupId: 2,
      meetingId: 3,
    },
    "/churchtools/api/groups/2/meetings/3",
  ],
  [
    "ct_list_group_meeting_members",
    {
      groupId: 2,
      meetingId: 3,
    },
    "/churchtools/api/groups/2/meetings/3/members",
  ],
  ["ct_list_followups", {}, "/churchtools/api/followups"],
  [
    "ct_get_followup",
    {
      followUpId: 1,
    },
    "/churchtools/api/followups/1",
  ],
  [
    "ct_list_group_followups",
    {
      groupId: 2,
    },
    "/churchtools/api/groups/2/followups",
  ],
  [
    "ct_list_person_followups",
    {
      personId: 7,
    },
    "/churchtools/api/persons/7/followups",
  ],
  ["ct_list_wiki_categories", {}, "/churchtools/api/wiki/categories"],
  [
    "ct_list_wiki_pages",
    {
      wikiCategoryId: 1,
    },
    "/churchtools/api/wiki/categories/1/pages",
  ],
  [
    "ct_get_wiki_page",
    {
      wikiCategoryId: 1,
      identifier: "Willkommen",
    },
    "/churchtools/api/wiki/categories/1/pages/Willkommen",
  ],
  [
    "ct_search_wiki",
    {
      query: "Start",
    },
    "/churchtools/api/wiki/search?query=Start",
  ],
  [
    "ct_list_wiki_page_versions",
    {
      wikiCategoryId: 1,
      identifier: "Willkommen",
    },
    "/churchtools/api/wiki/categories/1/pages/Willkommen/versions",
  ],
  [
    "ct_list_tags",
    {
      domainType: "person",
    },
    "/churchtools/api/tags/person",
  ],
  [
    "ct_list_object_tags",
    {
      domainType: "person",
      domainId: 7,
    },
    "/churchtools/api/tags/person/7",
  ],
  [
    "ct_list_notes",
    {
      domainType: "person",
      domainId: 7,
    },
    "/churchtools/api/notes/person/7",
  ],
  [
    "ct_list_relationships",
    {
      personId: 7,
    },
    "/churchtools/api/persons/7/relationships",
  ],
  [
    "ct_list_relationship_types",
    {},
    "/churchtools/api/person/relationshiptypes",
  ],
  ["ct_list_group_homepages", {}, "/churchtools/api/grouphomepages"],
  [
    "ct_get_group_homepage",
    {
      groupId: 2,
    },
    "/churchtools/api/groups/2/grouphomepage",
  ],
  [
    "ct_get_public_group",
    {
      groupId: 2,
    },
    "/churchtools/api/publicgroups/2",
  ],
  [
    "ct_get_public_group_form",
    {
      groupId: 2,
    },
    "/churchtools/api/publicgroups/2/form",
  ],
  ["ct_list_printers", {}, "/churchtools/api/printers"],
  [
    "ct_get_qrcode_checkin",
    {
      groupId: 2,
      personId: 7,
    },
    "/churchtools/api/groups/2/qrcodecheckin/7",
  ],
  [
    "ct_list_files",
    {
      domainType: "person",
      domainIdentifier: "7",
    },
    "/churchtools/api/files/person/7",
  ],
  [
    "ct_get_file_metadata",
    {
      fileId: 9,
    },
    "/churchtools/api/files/9/meta",
  ],
  [
    "ct_list_appointment_templates",
    {},
    "/churchtools/api/calendars/appointments/templates",
  ],
  [
    "ct_get_appointment_template",
    {
      templateId: 1,
    },
    "/churchtools/api/calendars/appointments/templates/1",
  ],
  [
    "ct_list_meeting_requests",
    {
      calendarId: 1,
      appointmentId: 2,
    },
    "/churchtools/api/calendars/1/appointments/2/meetingrequests",
  ],
  [
    "ct_list_open_meeting_requests",
    {
      personId: 7,
    },
    "/churchtools/api/persons/7/openmeetingrequests",
  ],
  ["ct_list_posts", {}, "/churchtools/api/posts"],
  [
    "ct_get_post",
    {
      postId: 1,
    },
    "/churchtools/api/posts/1",
  ],
  [
    "ct_list_post_comments",
    {
      postId: 1,
    },
    "/churchtools/api/posts/1/comments",
  ],
  [
    "ct_search_posts",
    {
      query: "Hallo",
    },
    "/churchtools/api/post/search?query=Hallo",
  ],
  [
    "ct_list_person_posts",
    {
      personId: 7,
    },
    "/churchtools/api/persons/7/posts",
  ],
  [
    "ct_list_permission_definitions",
    {},
    "/churchtools/api/permissions/definitions",
  ],
  ["ct_get_my_permissions", {}, "/churchtools/api/permissions/global"],
  [
    "ct_list_object_permissions",
    {
      domainType: "group",
      domainId: 2,
    },
    "/churchtools/api/permissions/group/2",
  ],
  [
    "ct_get_permission_origins",
    {
      personId: 7,
    },
    "/churchtools/api/permissions/origins/global/persons/7",
  ],
  [
    "ct_get_internal_permission_origins",
    {
      personId: 7,
    },
    "/churchtools/api/permissions/origins/internal/persons/7",
  ],
  ["ct_list_security_levels", {}, "/churchtools/api/securitylevels"],
];

test.each(reads)("%s reads %s at once", async (name, args, path) => {
  const { client, calls } = await ready([json({ data: [{ id: 1 }] })]);
  const result = await ok(client, name, args);
  expect(result).toBeTruthy();
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${path}`]);
});

test("ct_check_booking_conflicts only computes and writes nothing", async () => {
  const { client, calls } = await ready([json({ data: [{ bookingId: 9 }] })]);
  const result = await ok(client, "ct_check_booking_conflicts", {
    fields: { resourceId: 3 },
  });
  expect(result).toMatchObject({ conflicts: [{ bookingId: 9 }] });
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
    "POST /churchtools/api/bookings/conflicts",
  ]);
});
const plans: [
  string,
  Record<string, unknown>,
  string,
  string,
  string | null,
  boolean,
][] = [
  [
    "ct_create_agenda_item",
    {
      eventId: 5,
      fields: {
        title: "Begrüßung",
      },
    },
    "POST",
    "/events/5/agenda/items",
    "/events/5/agenda",
    false,
  ],
  [
    "ct_update_agenda_item",
    {
      eventId: 5,
      itemId: 1,
      fields: {
        title: "Neu",
      },
    },
    "PUT",
    "/events/5/agenda/items/1",
    "/events/5/agenda",
    false,
  ],
  [
    "ct_delete_agenda_item",
    {
      eventId: 5,
      itemId: 1,
    },
    "DELETE",
    "/events/5/agenda/items/1",
    "/events/5/agenda",
    false,
  ],
  [
    "ct_hide_agenda_item",
    {
      eventId: 5,
      itemId: 1,
    },
    "POST",
    "/events/5/agenda/items/1/hide",
    "/events/5/agenda",
    false,
  ],
  [
    "ct_unhide_agenda_item",
    {
      eventId: 5,
      itemId: 1,
    },
    "POST",
    "/events/5/agenda/items/1/unhide",
    "/events/5/agenda",
    false,
  ],
  [
    "ct_lock_agenda",
    {
      eventId: 5,
    },
    "POST",
    "/events/5/agenda/lock",
    "/events/5/agenda",
    false,
  ],
  [
    "ct_unlock_agenda",
    {
      eventId: 5,
    },
    "POST",
    "/events/5/agenda/unlock",
    "/events/5/agenda",
    false,
  ],
  [
    "ct_create_song",
    {
      fields: {
        name: "Neues Lied",
      },
    },
    "POST",
    "/songs",
    null,
    false,
  ],
  [
    "ct_update_song",
    {
      songId: 9,
      fields: {
        name: "Neu",
      },
    },
    "PUT",
    "/songs/9",
    "/songs/9",
    false,
  ],
  [
    "ct_delete_song",
    {
      songId: 9,
    },
    "DELETE",
    "/songs/9",
    "/songs/9",
    false,
  ],
  [
    "ct_create_song_arrangement",
    {
      songId: 9,
      fields: {
        name: "Standard",
      },
    },
    "POST",
    "/songs/9/arrangements",
    "/songs/9",
    false,
  ],
  [
    "ct_update_song_arrangement",
    {
      songId: 9,
      arrangementId: 2,
      fields: {
        name: "Neu",
      },
    },
    "PUT",
    "/songs/9/arrangements/2",
    "/songs/9/arrangements/2",
    false,
  ],
  [
    "ct_delete_song_arrangement",
    {
      songId: 9,
      arrangementId: 2,
    },
    "DELETE",
    "/songs/9/arrangements/2",
    "/songs/9/arrangements/2",
    false,
  ],
  [
    "ct_set_default_arrangement",
    {
      songId: 9,
      arrangementId: 2,
    },
    "PATCH",
    "/songs/9/arrangements/2/default",
    "/songs/9/arrangements/2",
    false,
  ],
  [
    "ct_accept_service_request",
    {
      eventId: 5,
      requestId: 8,
    },
    "POST",
    "/events/5/servicerequests/8/accept",
    "/events/5",
    false,
  ],
  [
    "ct_decline_service_request",
    {
      eventId: 5,
      requestId: 8,
    },
    "POST",
    "/events/5/servicerequests/8/decline",
    "/events/5",
    false,
  ],
  [
    "ct_undo_service_request",
    {
      eventId: 5,
      requestId: 8,
    },
    "POST",
    "/events/5/servicerequests/8/undo",
    "/events/5",
    false,
  ],
  [
    "ct_update_service_request",
    {
      eventId: 5,
      requestId: 8,
      fields: {
        personId: 7,
        isAccepted: true,
      },
    },
    "PUT",
    "/events/5/servicerequests/8",
    "/events/5",
    false,
  ],
  [
    "ct_create_exchange_request",
    {
      personId: 7,
      eventId: 5,
      serviceId: 6,
      fields: {
        comment: "Bitte tauschen",
      },
    },
    "POST",
    "/persons/7/events/5/services/6/exchangerequests",
    "/persons/7/exchangerequests",
    false,
  ],
  [
    "ct_accept_exchange_request",
    {
      personId: 7,
      requestId: 8,
    },
    "PUT",
    "/persons/7/exchangerequests/8",
    "/persons/7/exchangerequests",
    false,
  ],
  [
    "ct_decline_exchange_request",
    {
      personId: 7,
      requestId: 8,
    },
    "DELETE",
    "/persons/7/exchangerequests/8",
    "/persons/7/exchangerequests",
    false,
  ],
  [
    "ct_create_absence",
    {
      personId: 7,
      fields: {
        comment: "Urlaub",
        absenceReasonId: 1,
        startDate: "2026-11-01",
      },
    },
    "POST",
    "/persons/7/absences",
    "/persons/7/absences",
    false,
  ],
  [
    "ct_update_absence",
    {
      personId: 7,
      absenceId: 1,
      fields: {
        comment: "Neu",
      },
    },
    "PUT",
    "/persons/7/absences/1",
    "/persons/7/absences/1",
    false,
  ],
  [
    "ct_delete_absence",
    {
      personId: 7,
      absenceId: 1,
    },
    "DELETE",
    "/persons/7/absences/1",
    "/persons/7/absences/1",
    false,
  ],
  [
    "ct_create_booking",
    {
      fields: {
        resourceId: 3,
        caption: "Probe",
      },
    },
    "POST",
    "/bookings",
    null,
    true,
  ],
  [
    "ct_update_booking",
    {
      bookingId: 11,
      fields: {
        caption: "Neu",
      },
    },
    "PUT",
    "/bookings/11",
    "/bookings/11",
    true,
  ],
  [
    "ct_delete_booking",
    {
      bookingId: 11,
    },
    "DELETE",
    "/bookings/11",
    "/bookings/11",
    false,
  ],
  [
    "ct_answer_booking",
    {
      bookingId: 11,
      answer: "approve",
    },
    "PUT",
    "/bookings/11/approve",
    "/bookings/11",
    false,
  ],
  [
    "ct_set_event_fact",
    {
      eventId: 5,
      factId: 1,
      value: 42,
    },
    "PUT",
    "/events/5/facts/1",
    "/events/5/facts",
    false,
  ],
  [
    "ct_create_fact",
    {
      fields: {
        name: "Besucher",
      },
    },
    "POST",
    "/facts",
    null,
    false,
  ],
  [
    "ct_update_fact",
    {
      factId: 1,
      fields: {
        name: "Neu",
      },
    },
    "PUT",
    "/facts/1",
    "/facts/1",
    false,
  ],
  [
    "ct_delete_fact",
    {
      factId: 1,
    },
    "DELETE",
    "/facts/1",
    "/facts/1",
    false,
  ],
  [
    "ct_delete_event_fact",
    {
      eventId: 5,
      factId: 1,
    },
    "DELETE",
    "/events/5/facts/1",
    "/events/5/facts",
    false,
  ],
  [
    "ct_complete_followup",
    {
      followUpId: 1,
    },
    "POST",
    "/followups/1/complete",
    "/followups/1",
    false,
  ],
  [
    "ct_dismiss_followup",
    {
      followUpId: 1,
    },
    "POST",
    "/followups/1/dismiss",
    "/followups/1",
    false,
  ],
  [
    "ct_postpone_followup",
    {
      followUpId: 1,
      dueDate: "2026-12-01",
    },
    "POST",
    "/followups/1/postpone",
    "/followups/1",
    false,
  ],
  [
    "ct_create_wiki_category",
    {
      fields: {
        name: "Intern",
      },
    },
    "POST",
    "/wiki/categories",
    null,
    false,
  ],
  [
    "ct_update_wiki_category",
    {
      wikiCategoryId: 1,
      fields: {
        name: "Neu",
      },
    },
    "PUT",
    "/wiki/categories/1",
    "/wiki/categories",
    false,
  ],
  [
    "ct_delete_wiki_category",
    {
      wikiCategoryId: 1,
    },
    "DELETE",
    "/wiki/categories/1",
    "/wiki/categories",
    false,
  ],
  [
    "ct_create_wiki_page",
    {
      wikiCategoryId: 1,
      fields: {
        title: "Start",
        text: "Hallo",
      },
    },
    "POST",
    "/wiki/categories/1/pages",
    "/wiki/categories/1/pages",
    false,
  ],
  [
    "ct_update_wiki_page",
    {
      wikiCategoryId: 1,
      identifier: "Start",
      fields: {
        text: "Neu",
      },
    },
    "PATCH",
    "/wiki/categories/1/pages/Start",
    "/wiki/categories/1/pages/Start",
    false,
  ],
  [
    "ct_delete_wiki_page",
    {
      wikiCategoryId: 1,
      identifier: "Start",
    },
    "DELETE",
    "/wiki/categories/1/pages/Start",
    "/wiki/categories/1/pages/Start",
    false,
  ],
  [
    "ct_create_tag",
    {
      domainType: "person",
      name: "Team",
    },
    "POST",
    "/tags/person",
    "/tags/person",
    false,
  ],
  [
    "ct_add_tag",
    {
      domainType: "person",
      domainId: 7,
      name: "Team",
    },
    "POST",
    "/tags/person/7",
    "/tags/person/7",
    false,
  ],
  [
    "ct_remove_tag",
    {
      domainType: "person",
      domainId: 7,
      tagId: 3,
    },
    "DELETE",
    "/tags/person/7/3",
    "/tags/person/7",
    false,
  ],
  [
    "ct_delete_tag",
    {
      tagId: 3,
    },
    "DELETE",
    "/tags/3",
    "/tags/3",
    false,
  ],
  [
    "ct_add_note",
    {
      domainType: "person",
      domainId: 7,
      fields: {
        text: "Notiz hier",
        securityLevelId: 1,
      },
    },
    "POST",
    "/notes/person/7",
    "/notes/person/7",
    false,
  ],
  [
    "ct_update_note",
    {
      domainType: "person",
      domainId: 7,
      noteId: 2,
      fields: {
        text: "Neu",
      },
    },
    "PUT",
    "/notes/person/7/2",
    "/notes/person/7",
    false,
  ],
  [
    "ct_delete_note",
    {
      domainType: "person",
      domainId: 7,
      noteId: 2,
    },
    "DELETE",
    "/notes/person/7/2",
    "/notes/person/7",
    false,
  ],
  [
    "ct_create_relationship",
    {
      personId: 7,
      otherPersonId: 8,
      relationshipTypeId: 1,
    },
    "POST",
    "/persons/7/relationships",
    "/persons/7/relationships",
    false,
  ],
  [
    "ct_delete_relationship",
    {
      personId: 7,
      relationshipId: 2,
    },
    "DELETE",
    "/persons/7/relationships/2",
    "/persons/7/relationships",
    false,
  ],
  [
    "ct_answer_meeting_request",
    {
      calendarId: 1,
      appointmentId: 2,
      meetingRequestId: 3,
      answer: "accept",
    },
    "POST",
    "/calendars/1/appointments/2/meetingrequests/3/accept",
    "/calendars/1/appointments/2/meetingrequests",
    false,
  ],
];

test.each(plans)(
  "%s writes nothing and returns a guarded plan for %s %s",
  async (name, args, method, path, guardPath, conflicts) => {
    const answers: (Response | Error)[] = [];
    if (guardPath) answers.push(guard());
    if (conflicts) answers.push(json({ data: [] }));
    answers.push(...(guardPath ? [guard()] : []), json({ data: { ok: true } }));
    const { client, calls } = await ready(answers);
    const planned = await ok(client, name, args);
    expect(planned.token).toBeTypeOf("string");
    expect(planned.preview.changes[0]).toMatchObject({ method, path });
    const during = calls.map((c) => `${c.method} ${c.path}`);
    expect(during.filter((r) => !r.startsWith("GET"))).toEqual(
      conflicts ? ["POST /churchtools/api/bookings/conflicts"] : [],
    );
    const executed = await ok(client, "ct_execute_plan", {
      token: planned.token,
    });
    expect(executed.executed).toBeTypeOf("string");
    expect(calls.at(-1)?.method).toBe(method);
    expect(calls.at(-1)?.path).toBe(`/churchtools/api${path}`);
  },
);

test("a failed booking conflict check is noted in the plan preview, not hidden", async () => {
  const { client } = await ready([
    json({ message: "kaputt" }, { status: 500 }),
  ]);
  const planned = await ok(client, "ct_create_booking", {
    fields: { resourceId: 3 },
  });
  expect(String(planned.preview.bookingConflicts)).toContain("not checked");
});
