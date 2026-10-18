import { setTimeout as sleep } from "node:timers/promises";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { createServer } from "../../src/server.js";
import { refuseProduction } from "./guard.js";
import { totp } from "./totp.js";

/** Live tests write to a ChurchTools trial instance; they run only with every CT_LIVE_* variable set. */
const {
  CT_LIVE_URL,
  CT_LIVE_USERNAME,
  CT_LIVE_PASSWORD,
  CT_LIVE_TOTP_SECRET,
  CT_URL,
} = process.env;
const live = Boolean(
  CT_LIVE_URL && CT_LIVE_USERNAME && CT_LIVE_PASSWORD && CT_LIVE_TOTP_SECRET,
);
if (live) refuseProduction(CT_LIVE_URL, CT_URL);

interface Executed {
  executed: string;
  results: { request: string; result: unknown }[];
}
interface Assignment {
  id: number;
  serviceId?: number | null;
  personId?: number | null;
  name?: string | null;
  isValid?: boolean | null;
}
/** Only an open, valid assignment is used: the decline in cleanup reopens it, but cannot restore an assignee. */
const isOpen = (a: Assignment) => !a.personId && !a.name && a.isValid !== false;

const stamp = Date.now();
/** Every record the tests create carries it; cleanup touches nothing without it. */
const marker = `Live${stamp}`;
const day = (offset: number) =>
  new Date(stamp + offset * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!live)("ChurchTools trial instance", () => {
  /** The `data.status` of each login answer, by path. */
  const loginStatus: Record<string, unknown> = {};
  const realFetch = globalThis.fetch;
  const recordingFetch: typeof fetch = async (input, init) => {
    const response = await realFetch(input, init);
    const url = input instanceof Request ? input.url : String(input);
    const path = new URL(url).pathname.replace(/^.*\/api/, "");
    if (path === "/login" || path === "/login/totp") {
      const body = (await response
        .clone()
        .json()
        .catch(() => undefined)) as { data?: { status?: unknown } } | undefined;
      loginStatus[path] = body?.data?.status;
    }
    return response;
  };
  let client: Client;

  /** The tool's JSON answer; a tool error fails the test with its text. */
  async function call(name: string, args = {}): Promise<unknown> {
    const { text, isError } = await tryCall(name, args);
    if (isError) throw new Error(`${name} failed: ${text}`);
    return JSON.parse(text);
  }

  async function tryCall(name: string, args = {}) {
    const result = await client.callTool({ name, arguments: args });
    const [content] = result.content as { text: string }[];
    return { text: content?.text ?? "", isError: result.isError ?? false };
  }

  async function readEvent(eventId: number) {
    return (await call("ct_get_event", { eventId })) as {
      eventServices: Assignment[];
    };
  }

  async function execute(token: string): Promise<Executed> {
    return (await call("ct_execute_plan", { token })) as Executed;
  }

  /** Plans a write with `tool` and executes it at once. */
  async function write(tool: string, args: object): Promise<Executed> {
    const { token } = (await call(tool, args)) as { token: string };
    return execute(token);
  }

  /** Each cleanup finds its records by `marker` itself, so a write that landed but reported an error is undone too. */
  const cleanups: (() => Promise<unknown>)[] = [];
  const onCleanup = (undo: () => Promise<unknown>) => cleanups.push(undo);

  afterEach(async () => {
    const failures: unknown[] = [];
    for (const undo of cleanups.splice(0).reverse()) {
      await undo().catch((error: unknown) => failures.push(error));
    }
    if (failures.length > 0) throw new AggregateError(failures, "Cleanup");
  });

  async function deleteMarkedPersons() {
    const { persons } = (await call("ct_search_persons", {
      query: marker,
    })) as { persons: { id: number; firstName?: string | null }[] };
    for (const { id, firstName } of persons) {
      if (firstName === marker)
        await write("ct_delete_person", { personId: id });
    }
  }

  /** Creates a person named `marker` `lastName`; afterEach deletes every person named `marker`. */
  async function createPerson(lastName: string) {
    const masterdata = (await call("ct_api_request", {
      method: "GET",
      path: "/person/masterdata",
    })) as {
      data: {
        departments: { id: number }[];
        statuses: { id: number }[];
        campuses: { id: number }[];
      };
    };
    const [department] = masterdata.data.departments;
    const [status] = masterdata.data.statuses;
    const [campus] = masterdata.data.campuses;
    if (!department || !status || !campus)
      throw new Error("The instance lacks a department, status or campus");
    const { token, preview } = (await call("ct_create_person", {
      firstName: marker,
      lastName,
      departmentIds: [department.id],
      // An instance may demand status, campus and the privacy agreement; this test person agreed outside ChurchTools.
      fields: {
        statusId: status.id,
        campusId: campus.id,
        privacyPolicyAgreementTypeId: 3,
        privacyPolicyAgreementWhoId: 1,
        privacyPolicyAgreementDate: day(0),
      },
    })) as { token: string; preview: { possibleDuplicates: unknown } };
    // Empty: the duplicate check by firstName and lastName ran and filtered (a failed check is a text).
    expect(preview.possibleDuplicates).toEqual([]);
    onCleanup(deleteMarkedPersons);
    const { results } = await execute(token);
    return (results[0]?.result as { data: { id: number } }).data.id;
  }

  /** The appointments of the test day in `calendarId` whose title holds `marker`. */
  async function markedAppointments(calendarId: number) {
    const { appointments } = (await call("ct_list_appointments", {
      calendar_ids: [calendarId],
      from: day(2),
      to: day(3),
    })) as { appointments: { id: number; title?: string | null }[] };
    return appointments.filter((a) => a.title?.includes(marker));
  }

  /** An open, valid service assignment of an event in the next 60 days, or undefined. */
  async function findOpenSlot() {
    const { events } = (await call("ct_list_events", {
      from: day(0),
      to: day(60),
    })) as { events: { id: number; eventServices: Assignment[] }[] };
    const event = events.find((e) => e.eventServices.some(isOpen));
    const slot = event?.eventServices.find(isOpen);
    return event && slot ? { eventId: event.id, slot } : undefined;
  }

  /**
   * Declines our assignment of `slot`'s service, then checks that the service has an open slot again.
   * ChurchTools gives a filled assignment a new id, so it is found by service and `ours`, not by `slot.id`.
   */
  function onCleanupSlot(
    eventId: number,
    slot: Assignment,
    ours: (a: Assignment) => boolean,
  ) {
    onCleanup(async () => {
      const { eventServices } = await readEvent(eventId);
      const mine = eventServices.find(
        (a) => a.serviceId === slot.serviceId && ours(a),
      );
      if (!mine) return;
      await write("ct_api_request", {
        method: "POST",
        path: `/events/${eventId}/servicerequests/${mine.id}/decline`,
        body: { comment: "live test cleanup" },
      });
      const after = await readEvent(eventId);
      expect(
        after.eventServices.some(
          (a) => a.serviceId === slot.serviceId && isOpen(a),
        ),
      ).toBe(true);
    });
  }

  beforeAll(async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const env = {
      CT_URL: CT_LIVE_URL,
      CT_USERNAME: CT_LIVE_USERNAME,
      CT_PASSWORD: CT_LIVE_PASSWORD,
    };
    await createServer({ env, fetch: recordingFetch }).connect(serverTransport);
    client = new Client({ name: "live-test", version: "0.0.0" });
    await client.connect(clientTransport);
    // A code that turns stale on the way fails the login; wait for the next 30 s step instead.
    if ((Date.now() / 1000) % 30 > 27) await sleep(3_000);
    await call("ct_login", { code: totp(CT_LIVE_TOTP_SECRET ?? "") });
  });

  test("ct_login completes the real 2FA login", async () => {
    expect(loginStatus).toEqual({
      "/login": "totp",
      "/login/totp": "success",
    });
    expect(await call("ct_status")).toMatchObject({ state: "ready" });
  });

  test("a person is created, updated and deleted", async () => {
    const personId = await createPerson(`Person ${stamp}`);

    await write("ct_update_person", {
      personId,
      fields: { lastName: `Renamed ${stamp}` },
    });
    expect(await call("ct_get_person", { personId })).toMatchObject({
      lastName: `Renamed ${stamp}`,
    });

    await write("ct_delete_person", { personId });
    expect((await tryCall("ct_get_person", { personId })).isError).toBe(true);
  });

  test("a person is added to a group and removed from it", async ({ skip }) => {
    const { groups } = (await call("ct_search_groups", {
      group_status_ids: [1],
      limit: 1,
    })) as { groups: { id: number }[] };
    const group = groups[0];
    if (!group) return skip("The trial instance has no active group");
    const personId = await createPerson(`Member ${stamp}`);
    const membership = { groupId: group.id, personId };
    const path = `/groups/${group.id}/members/${personId}`;
    const isMember = async () =>
      !(await tryCall("ct_api_request", { method: "GET", path })).isError;
    // The person carries the marker, so a membership of theirs is ours.
    onCleanup(async () => {
      if (await isMember()) await write("ct_remove_group_member", membership);
    });

    await write("ct_add_group_member", membership);
    expect(
      await call("ct_api_request", { method: "GET", path }),
    ).toHaveProperty("data.personId", personId);

    await write("ct_remove_group_member", membership);
    expect(await isMember()).toBe(false);
  });

  test("a group is created, read, changed, given a member role and deleted", async ({
    skip,
  }) => {
    const masterdata = (await call("ct_api_request", {
      method: "GET",
      path: "/person/masterdata",
    })) as {
      data: {
        groupTypes: { id: number }[];
        roles: { id: number; groupTypeId: number; isDefault: boolean }[];
      };
    };
    const [groupType] = masterdata.data.groupTypes;
    if (!groupType) return skip("The trial instance has no group type");
    const role = masterdata.data.roles.find(
      (r) => r.groupTypeId === groupType.id && !r.isDefault,
    );
    if (!role) return skip("The group type has no second role");
    const name = `${marker} group`;
    onCleanup(async () => {
      const { groups } = (await call("ct_search_groups", {
        query: marker,
      })) as { groups: { id: number; name?: string | null }[] };
      for (const group of groups) {
        if (group.name === name)
          await write("ct_delete_group", { groupId: group.id });
      }
    });

    const created = await write("ct_create_group", {
      name,
      groupTypeId: groupType.id,
      groupStatusId: 1,
    });
    const groupId = (created.results[0]?.result as { data: { id: number } })
      .data.id;
    expect(await call("ct_get_group", { groupId })).toMatchObject({ name });

    await write("ct_update_group", { groupId, fields: { note: marker } });
    expect(await call("ct_get_group", { groupId })).toMatchObject({
      information: { note: marker },
    });

    const personId = await createPerson(`Role ${stamp}`);
    await write("ct_add_group_member", { groupId, personId });
    await write("ct_update_group_member", {
      groupId,
      personId,
      groupTypeRoleId: role.id,
      comment: marker,
    });
    expect(await call("ct_list_group_members", { groupId })).toMatchObject({
      members: [{ personId, groupTypeRoleId: role.id }],
    });

    await write("ct_delete_group", { groupId });
    expect((await tryCall("ct_get_group", { groupId })).isError).toBe(true);
  });

  test("a group category in the masterdata is created, renamed and deleted through ct_api_request", async () => {
    const categories = async () =>
      (
        (await call("ct_api_request", {
          method: "GET",
          path: "/person/masterdata",
        })) as { data: { groupCategories: { id: number; name: string }[] } }
      ).data.groupCategories.filter((c) => c.name.startsWith(marker));
    // ChurchTools demands dryRun on this delete, though the spec makes it optional.
    const remove = (id: number) =>
      write("ct_api_request", {
        method: "DELETE",
        path: `/group/groupcategories/${id}`,
        query: { dryRun: false },
      });
    onCleanup(async () => {
      for (const { id } of await categories()) await remove(id);
    });

    const created = await write("ct_api_request", {
      method: "POST",
      path: "/group/groupcategories",
      body: { name: `${marker} category`, color: "blue", sortKey: 999 },
    });
    const id = (created.results[0]?.result as { data: { id: number } }).data.id;
    const path = `/group/groupcategories/${id}`;

    await write("ct_api_request", {
      method: "PUT",
      path,
      body: { name: `${marker} renamed`, color: "green", sortKey: 999 },
    });
    expect(
      await call("ct_api_request", { method: "GET", path }),
    ).toHaveProperty("data.name", `${marker} renamed`);

    await remove(id);
    expect(await categories()).toEqual([]);
  });

  test("an event made from a template is listed for its day, changed and deleted", async ({
    skip,
  }) => {
    const templates = (await call("ct_api_request", {
      method: "GET",
      path: "/eventtemplates",
    })) as { data: { id: number; calendarId?: number | null }[] };
    const template = templates.data.find((t) => t.id > 0 && t.calendarId);
    if (!template?.calendarId)
      return skip("The trial instance has no event template with a calendar");
    const calendarId = template.calendarId;
    const title = `${marker} event`;
    // Deleting the appointment also deletes an event that is still there.
    onCleanup(async () => {
      for (const { id } of await markedAppointments(calendarId)) {
        await write("ct_delete_appointment", { calendarId, appointmentId: id });
      }
    });
    const startDate = `${day(2)}T10:00:00Z`;

    await write("ct_create_appointment", {
      calendarId,
      title,
      startDate,
      endDate: `${day(2)}T11:00:00Z`,
      fields: { events: [{ eventTemplateId: template.id, startDate }] },
    });
    // One day as from and to: the list must include its last day.
    const { events } = (await call("ct_list_events", {
      from: day(2),
      to: day(2),
    })) as { events: { id: number; name?: string | null }[] };
    const event = events.find((e) => e.name === title);
    if (!event) throw new Error(`${title} was not listed for its day`);
    const eventId = event.id;

    await write("ct_update_event", { eventId, note: marker, isCanceled: true });
    expect(await call("ct_get_event", { eventId })).toMatchObject({
      note: marker,
      isCanceled: true,
    });

    await write("ct_delete_event", { eventId });
    expect((await tryCall("ct_get_event", { eventId })).isError).toBe(true);
  });

  test("an appointment is created, renamed and deleted", async ({ skip }) => {
    const { calendars } = (await call("ct_list_calendars")) as {
      calendars: { id: number }[];
    };
    const calendar = calendars[0];
    if (!calendar) return skip("The trial instance has no calendar");
    const calendarId = calendar.id;
    const title = `${marker} appointment`;
    onCleanup(async () => {
      for (const { id } of await markedAppointments(calendarId)) {
        await write("ct_delete_appointment", { calendarId, appointmentId: id });
      }
    });

    await write("ct_create_appointment", {
      calendarId,
      title,
      startDate: `${day(2)}T10:00:00Z`,
      endDate: `${day(2)}T11:00:00Z`,
    });
    const [created] = await markedAppointments(calendarId);
    if (!created) throw new Error(`${title} was not found after its create`);
    const appointmentId = created.id;

    await write("ct_update_appointment", {
      calendarId,
      appointmentId,
      title: `Renamed ${title}`,
    });
    expect(
      await call("ct_get_appointment", { calendarId, appointmentId }),
    ).toMatchObject({ appointment: { title: `Renamed ${title}` } });

    await write("ct_delete_appointment", { calendarId, appointmentId });
    expect(
      (await tryCall("ct_get_appointment", { calendarId, appointmentId }))
        .isError,
    ).toBe(true);
  });

  test("an external helper fills an open event service", async ({ skip }) => {
    const open = await findOpenSlot();
    if (!open) return skip("No event in the next 60 days has an open service");
    const { eventId, slot } = open;
    const name = `${marker} Helper`;
    onCleanupSlot(eventId, slot, (a) => a.name === name);

    await write("ct_set_external_event_service", {
      eventId,
      eventServiceId: slot.id,
      name,
    });

    const { eventServices } = await readEvent(eventId);
    expect(eventServices).toContainEqual(
      expect.objectContaining({ serviceId: slot.serviceId, name }),
    );
  });

  test("the logged-in user is assigned to an open event service", async ({
    skip,
  }) => {
    const open = await findOpenSlot();
    if (!open) return skip("No event in the next 60 days has an open service");
    const { eventId, slot } = open;
    const { personId } = (await call("ct_status")) as { personId: number };
    // The slot was open before this test, so the user in it is ours.
    onCleanupSlot(eventId, slot, (a) => a.personId === personId);

    await write("ct_assign_event_service", {
      eventId,
      eventServiceId: slot.id,
      personId,
    });

    const { eventServices } = await readEvent(eventId);
    expect(eventServices).toContainEqual(
      expect.objectContaining({ serviceId: slot.serviceId, personId }),
    );
  });

  test("a plan whose record changed after the preview writes nothing", async () => {
    const personId = await createPerson(`Guard ${stamp}`);
    const { token } = (await call("ct_update_person", {
      personId,
      fields: { lastName: `Planned ${stamp}` },
    })) as { token: string };

    await write("ct_update_person", {
      personId,
      fields: { lastName: `Between ${stamp}` },
    });
    const stale = await tryCall("ct_execute_plan", { token });

    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("Nothing was written");
    expect(stale.text).toContain("changed since the preview");
    expect(await call("ct_get_person", { personId })).toMatchObject({
      lastName: `Between ${stamp}`,
    });
  });
});
