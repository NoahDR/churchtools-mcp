import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Query, parse } from "../ct/client.js";
import type { Session } from "../ct/session.js";
import { type Plans, changedOnly, guardOf, readGuarded } from "../plans.js";
import {
  id,
  limit,
  page,
  parseList,
  plan,
  read,
  withoutForce,
} from "./common.js";
import { toolResult } from "./result.js";

const groupId = id.describe("The group's id");
const personId = id.describe("The person's id");
const text = z.string().trim().min(1, "must not be blank");
const date = z.iso.date().describe("A date as YYYY-MM-DD");
const memberStatus = z
  .enum(["active", "requested", "waiting", "to_delete"])
  .describe(
    "active, requested (awaits confirmation), waiting (waiting list) or to_delete (pending removal)",
  );
const fieldMap = z.record(z.string(), z.unknown());
/** A nested object as read: missing, null or PHP's empty array `[]` is an empty object. */
const nested = fieldMap.catch({});

/** A list shows these fields only. */
const compactGroup = z
  .object({
    id: z.number(),
    name: z.string().nullish(),
    information: z
      .object({
        groupTypeId: z.number().nullish(),
        groupStatusId: z.number().nullish(),
      })
      .catch({}),
  })
  .transform(({ id, name, information }) => ({
    id,
    name,
    groupTypeId: information.groupTypeId,
    groupStatusId: information.groupStatusId,
  }));
const compactMember = z
  .object({
    personId: z.number(),
    person: z.object({ title: z.string().nullish() }).catch({}),
    groupTypeRoleId: z.number().nullish(),
    groupMemberStatus: z.string().nullish(),
  })
  .transform(({ personId, person, groupTypeRoleId, groupMemberStatus }) => ({
    personId,
    name: person.title ?? undefined,
    groupTypeRoleId,
    groupMemberStatus,
  }));
const groupRecord = z.object({
  data: z.object({
    id: z.number(),
    name: z.string().nullish(),
    information: nested,
    settings: nested,
  }),
});

const title = z.object({ title: z.string().nullish() }).catch({});
const membership = z
  .object({
    person: title,
    group: title,
    groupMemberStatus: z.string().nullish().catch(undefined),
  })
  .catch({ person: {}, group: {} });
const groupName = z.object({ name: z.string().nullish() }).catch({});

/** "group 5 (Youth)", or "group 5" without a title. */
function label(kind: "group" | "person", id: number, title?: string | null) {
  return title ? `${kind} ${id} (${title})` : `${kind} ${id}`;
}

/**
 * PATCH takes flat field names (`note`, `visibility`); GET nests them in `information` and `settings`.
 * `settings` wins where both have a field (`maxMembers`, `signUpOverrideRoleId`): the spec marks
 * `information.maxMembers` deprecated.
 */
function patchView(group: unknown): Record<string, unknown> {
  const record = nested.parse(group);
  return {
    ...record,
    ...nested.parse(record.information),
    ...nested.parse(record.settings),
  };
}

const searchInput = z.object({
  query: z
    .string()
    .trim()
    .min(2)
    .optional()
    .describe("Search text, at least 2 characters"),
  group_type_ids: z
    .array(id)
    .optional()
    .describe("Only groups of these group type ids"),
  group_status_ids: z
    .array(id)
    .optional()
    .describe(
      "Only groups with these status ids: 1 active, 2 pending, 3 archived, 4 finished",
    ),
  page: page.optional(),
  limit: limit("Groups", 200),
});

const memberChanges = {
  groupTypeRoleId: id.optional().describe("The role id"),
  groupMemberStatus: memberStatus.optional(),
  comment: z.string().nullable().optional().describe("null clears it"),
  memberStartDate: date
    .nullable()
    .optional()
    .describe("YYYY-MM-DD; an active membership needs one"),
  memberEndDate: date
    .nullable()
    .optional()
    .describe("YYYY-MM-DD; null clears it"),
};

/** Registers the group and membership tools: reads answer at once, writes return a plan for ct_execute_plan. */
export function registerGroupTools(
  server: McpServer,
  { session, plans }: { session: Pick<Session, "use">; plans: Plans },
): void {
  const get = (path: string, query?: Query) =>
    session.use((client) => client.request("GET", path, { query }));

  /** The person, group and status a membership record names. */
  function membershipLabels(group: number, person: number, record: unknown) {
    const parts = membership.parse(record);
    return {
      person: label("person", person, parts.person.title),
      group: label("group", group, parts.group.title),
      status: parts.groupMemberStatus,
    };
  }

  server.registerTool(
    "ct_search_groups",
    {
      title: "Search ChurchTools groups",
      description:
        "Finds groups by text, group type or status. Lists only id, name, group type id and status id; use ct_get_group for the whole group.",
      inputSchema: searchInput,
      annotations: read,
    },
    ({ group_type_ids, group_status_ids, ...rest }) =>
      toolResult(async () => {
        const answer = await get("/groups", {
          ...rest,
          "group_type_ids[]": group_type_ids,
          "group_status_ids[]": group_status_ids,
        });
        const { data, ...pagination } = parseList(
          compactGroup,
          answer,
          "/groups",
        );
        return { groups: data, ...pagination };
      }),
  );

  server.registerTool(
    "ct_get_group",
    {
      title: "Get a ChurchTools group",
      description:
        "Shows a group's id, name, information (type, status, note, meeting time…) and settings. Its roles come from GET /groups/{groupId}/roles (ct_api_request).",
      inputSchema: z.object({ groupId }),
      annotations: read,
    },
    ({ groupId }) =>
      toolResult(async () => {
        const path = `/groups/${groupId}`;
        return parse(groupRecord, await get(path), path).data;
      }),
  );

  server.registerTool(
    "ct_list_group_members",
    {
      title: "List the members of a ChurchTools group",
      description:
        "Lists a group's members with person id, name, role id (groupTypeRoleId) and membership status.",
      inputSchema: z.object({
        groupId,
        role_ids: z
          .array(id)
          .optional()
          .describe("Only members with these role ids"),
        group_member_statuses: z
          .array(memberStatus)
          .optional()
          .describe("Only members with these statuses"),
        query: text
          .optional()
          .describe("Part of the member's first or last name"),
        page: page.optional(),
        limit: limit("Members", 200),
      }),
      annotations: read,
    },
    ({ groupId, role_ids, group_member_statuses, ...rest }) =>
      toolResult(async () => {
        const path = `/groups/${groupId}/members`;
        const answer = await get(path, {
          ...rest,
          "role_ids[]": role_ids,
          "group_member_statuses[]": group_member_statuses,
        });
        const { data, ...pagination } = parseList(compactMember, answer, path);
        return { members: data, ...pagination };
      }),
  );

  server.registerTool(
    "ct_create_group",
    {
      title: "Plan a new ChurchTools group",
      description:
        "Writes nothing: returns a plan to create a group. If ChurchTools refuses a group of the same name, the result says so.",
      inputSchema: z.object({
        name: text.describe("The group's name"),
        groupTypeId: id.describe("The group type id"),
        groupStatusId: id.describe(
          "1 active, 2 pending (draft), 3 archived, 4 finished; a new group is usually 1",
        ),
        fields: fieldMap
          .optional()
          .describe(
            "Further fields of the group, e.g. campusId, parentGroupId, visibility",
          ),
      }),
      annotations: plan,
    },
    ({ name, groupTypeId, groupStatusId, fields }) =>
      toolResult(async () => {
        const body = {
          ...withoutForce(fields),
          name,
          groupTypeId,
          groupStatusId,
        };
        // Nothing to read first, but a plan needs a ready session like every other tool.
        await session.use(() => Promise.resolve());
        return plans.createPlan({
          summary: `Create group ${name}`,
          changes: [{ method: "POST", path: "/groups", body }],
          guards: [],
        });
      }),
  );

  server.registerTool(
    "ct_update_group",
    {
      title: "Plan a change to a ChurchTools group",
      description:
        "Writes nothing: returns a plan that patches only the fields whose value changes; null clears a field. Fields go by their flat names, e.g. name, note, groupStatusId, visibility.",
      inputSchema: z.object({
        groupId,
        fields: fieldMap
          .refine(
            (f) => Object.keys(f).length > 0,
            "must name at least one field",
          )
          .describe("The fields to set, e.g. { note: 'Fridays 7 pm' }"),
      }),
      annotations: plan,
    },
    ({ groupId, fields }) =>
      toolResult(async () => {
        const path = `/groups/${groupId}`;
        const { guard, before } = await readGuarded(session, path);
        const current = patchView(before);
        const body = changedOnly(current, withoutForce(fields));
        if (Object.keys(body).length === 0) {
          throw new Error(
            `No change: group ${groupId} already has these values`,
          );
        }
        return plans.createPlan({
          summary: `Update ${label("group", groupId, groupName.parse(before).name)}`,
          changes: [{ method: "PATCH", path, body, before: current }],
          guards: [guard],
        });
      }),
  );

  server.registerTool(
    "ct_delete_group",
    {
      title: "Plan to delete a ChurchTools group",
      description:
        "Writes nothing: returns a plan to delete a group and with it every membership; the preview shows the whole group, as a delete cannot be undone.",
      inputSchema: z.object({ groupId }),
      annotations: plan,
    },
    ({ groupId }) =>
      toolResult(async () => {
        const path = `/groups/${groupId}`;
        const { guard, before } = await readGuarded(session, path);
        return plans.createPlan({
          summary: `Delete ${label("group", groupId, groupName.parse(before).name)}`,
          changes: [{ method: "DELETE", path, before }],
          guards: [guard],
        });
      }),
  );

  server.registerTool(
    "ct_add_group_member",
    {
      title: "Plan to add a person to a ChurchTools group",
      description:
        "Writes nothing: returns a plan that adds the person to the group. A person who is already a member is an error; use ct_update_group_member. Role ids come from GET /groups/{groupId}/roles (ct_api_request).",
      inputSchema: z.object({
        groupId,
        personId,
        groupTypeRoleId: memberChanges.groupTypeRoleId,
        groupMemberStatus: memberStatus
          .optional()
          .describe("ChurchTools sets active when it is left out"),
        comment: z.string().optional(),
        memberStartDate: date
          .optional()
          .describe(
            "YYYY-MM-DD; ChurchTools sets today for an active membership",
          ),
      }),
      annotations: plan,
    },
    ({ groupId, personId, ...body }) =>
      toolResult(async () => {
        const path = `/groups/${groupId}/members/${personId}`;
        const { guard, before } = await guardOf(session, path);
        if (!("absent" in guard)) {
          const { person, group, status } = membershipLabels(
            groupId,
            personId,
            before,
          );
          throw new Error(
            `${person} is already a member of ${group} (status ${status ?? "unknown"}); use ct_update_group_member to change the membership`,
          );
        }
        return plans.createPlan({
          summary: `Add person ${personId} to group ${groupId}`,
          changes: [{ method: "PUT", path, body }],
          guards: [guard],
        });
      }),
  );

  server.registerTool(
    "ct_update_group_member",
    {
      title: "Plan a change to a ChurchTools group membership",
      description:
        "Writes nothing: returns a plan that patches only the membership fields whose value changes: role, status, comment, start and end date.",
      inputSchema: z.object({ groupId, personId, ...memberChanges }),
      annotations: plan,
    },
    ({ groupId, personId, ...changes }) =>
      toolResult(async () => {
        if (Object.values(changes).every((value) => value === undefined)) {
          throw new Error(
            "Name at least one change: groupTypeRoleId, groupMemberStatus, comment, memberStartDate or memberEndDate",
          );
        }
        const path = `/groups/${groupId}/members/${personId}`;
        const { guard, before } = await readGuarded(session, path);
        const body = changedOnly(before, changes);
        const { person, group } = membershipLabels(groupId, personId, before);
        if (Object.keys(body).length === 0) {
          throw new Error(
            `No change: the membership of ${person} in ${group} already has these values`,
          );
        }
        return plans.createPlan({
          summary: `Update the membership of ${person} in ${group}`,
          changes: [{ method: "PATCH", path, body, before }],
          guards: [guard],
        });
      }),
  );

  server.registerTool(
    "ct_remove_group_member",
    {
      title: "Plan to remove a person from a ChurchTools group",
      description:
        "Writes nothing: returns a plan that removes the person from the group; the preview shows the whole membership.",
      inputSchema: z.object({ groupId, personId }),
      annotations: plan,
    },
    ({ groupId, personId }) =>
      toolResult(async () => {
        const path = `/groups/${groupId}/members/${personId}`;
        const { guard, before } = await readGuarded(session, path);
        const { person, group } = membershipLabels(groupId, personId, before);
        return plans.createPlan({
          summary: `Remove ${person} from ${group}`,
          changes: [{ method: "DELETE", path, before }],
          guards: [guard],
        });
      }),
  );
}
