import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  id,
  registerPlans,
  registerReads,
  type ToolDeps,
  S,
} from "./api-tools.js";

const groupId = id.describe("The group's id");
const meetingId = id.describe("The group meeting's id");
const followUpId = id.describe("The follow-up's id");

/** Group meetings/attendance (read-only) and follow-ups (Follow-Up tag). Creating meetings or follow-ups is not offered here; complete/dismiss/postpone are plans. */
export function registerMeetingFollowupTools(
  server: McpServer,
  deps: ToolDeps,
): void {
  registerReads(server, deps, [
    {
      name: "ct_list_group_meetings",
      title: "List group meetings",
      description: "Lists the meetings of one group.",
      input: z.object({ groupId }),
      path: (a) => `/groups/${S(a.groupId)}/meetings`,
      key: "meetings",
    },
    {
      name: "ct_get_group_meeting",
      title: "Get a group meeting",
      description: "Shows one meeting of one group.",
      input: z.object({ groupId, meetingId }),
      path: (a) => `/groups/${S(a.groupId)}/meetings/${S(a.meetingId)}`,
      key: "meeting",
    },
    {
      name: "ct_list_group_meeting_members",
      title: "List a group meeting's members (attendance)",
      description:
        "Lists the members of one group meeting with their attendance state.",
      input: z.object({ groupId, meetingId }),
      path: (a) => `/groups/${S(a.groupId)}/meetings/${S(a.meetingId)}/members`,
      key: "members",
    },
    {
      name: "ct_list_followups",
      title: "List follow-ups",
      description: "Lists follow-ups.",
      input: z.object({ page: id.optional(), limit: id.max(500).optional() }),
      path: () => "/followups",
      query: (a) => ({ page: a.page as number, limit: a.limit as number }),
      key: "followups",
    },
    {
      name: "ct_get_followup",
      title: "Get a follow-up",
      description: "Shows one follow-up.",
      input: z.object({ followUpId }),
      path: (a) => `/followups/${S(a.followUpId)}`,
      key: "followup",
    },
    {
      name: "ct_list_group_followups",
      title: "List a group's follow-ups",
      description: "Lists the follow-ups of one group.",
      input: z.object({ groupId }),
      path: (a) => `/groups/${S(a.groupId)}/followups`,
      key: "followups",
    },
    {
      name: "ct_list_person_followups",
      title: "List a person's follow-ups",
      description: "Lists the follow-ups concerning one person.",
      input: z.object({ personId: id.describe("The person's id") }),
      path: (a) => `/persons/${S(a.personId)}/followups`,
      key: "followups",
    },
  ]);
  const guard = (a: { followUpId?: unknown }) =>
    `/followups/${S(a.followUpId)}`;
  registerPlans(server, deps, [
    {
      name: "ct_complete_followup",
      title: "Plan to complete a follow-up",
      description: "Marks a follow-up as completed.",
      input: z.object({ followUpId }),
      method: "POST",
      path: (a) => `/followups/${S(a.followUpId)}/complete`,
      guardPath: guard,
      summary: (a) => `Complete follow-up ${S(a.followUpId)}`,
    },
    {
      name: "ct_dismiss_followup",
      title: "Plan to dismiss a follow-up",
      description: "Dismisses a follow-up.",
      input: z.object({ followUpId }),
      method: "POST",
      path: (a) => `/followups/${S(a.followUpId)}/dismiss`,
      guardPath: guard,
      summary: (a) => `Dismiss follow-up ${S(a.followUpId)}`,
    },
    {
      name: "ct_postpone_followup",
      title: "Plan to postpone a follow-up",
      description: "Postpones a follow-up to a new due date (YYYY-MM-DD).",
      input: z.object({ followUpId, dueDate: z.iso.date() }),
      method: "POST",
      path: (a) => `/followups/${S(a.followUpId)}/postpone`,
      guardPath: guard,
      body: (a) => ({ dueDate: a.dueDate }),
      summary: (a) =>
        `Postpone follow-up ${S(a.followUpId)} to ${S(a.dueDate)}`,
    },
  ]);
}
