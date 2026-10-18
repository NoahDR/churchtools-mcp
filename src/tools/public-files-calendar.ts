import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  id,
  registerPlans,
  registerReads,
  slug,
  type ToolDeps,
  S,
} from "./api-tools.js";

const groupId = id.describe("The group's id");
const personId = id.describe("The person's id");

/**
 * Group homepages / public groups (read-only — signup, mail-to-leaders and token operations
 * deliberately have no tool), check-in (read-only — no person is created or checked in here,
 * for data-protection reasons, especially with children), files (metadata only, no binary
 * upload) and calendar extras (appointment templates, meeting requests).
 */
export function registerPublicFileCalendarTools(
  server: McpServer,
  deps: ToolDeps,
): void {
  registerReads(server, deps, [
    {
      name: "ct_list_group_homepages",
      title: "List group homepages",
      description: "Lists every enabled group homepage.",
      input: z.object({}),
      path: () => "/grouphomepages",
      key: "homepages",
    },
    {
      name: "ct_get_group_homepage",
      title: "Get a group's homepage info",
      description: "Shows the group homepage information of one group.",
      input: z.object({ groupId }),
      path: (a) => `/groups/${S(a.groupId)}/grouphomepage`,
      key: "homepage",
    },
    {
      name: "ct_get_public_group",
      title: "Get public group info",
      description: "Shows the public information of one public group.",
      input: z.object({ groupId }),
      path: (a) => `/publicgroups/${S(a.groupId)}`,
      key: "group",
    },
    {
      name: "ct_get_public_group_form",
      title: "Get a public group's sign-up form",
      description:
        "Shows the sign-up form definition of one public group (reading only; signing up has no tool).",
      input: z.object({ groupId }),
      path: (a) => `/publicgroups/${S(a.groupId)}/form`,
      key: "form",
    },
    {
      name: "ct_list_printers",
      title: "List check-in printers",
      description:
        "Lists the printers known to check-in. Check-in itself and creating persons at check-in have no tool (data protection, especially for children).",
      input: z.object({}),
      path: () => "/printers",
      key: "printers",
    },
    {
      name: "ct_get_qrcode_checkin",
      title: "Get a person's QR-code check-in info",
      description:
        "Shows the QR-code check-in info of one person in one group (reading only).",
      input: z.object({ groupId, personId }),
      path: (a) => `/groups/${S(a.groupId)}/qrcodecheckin/${S(a.personId)}`,
      key: "checkin",
    },
    {
      name: "ct_list_files",
      title: "List an object's files (metadata)",
      description:
        "Lists file metadata of one domain object. Binary up- and downloads have no tool.",
      input: z.object({
        domainType: z
          .string()
          .regex(/^[a-z]+$/, "must be a lowercase domain type"),
        domainIdentifier: slug.describe("The domain object's identifier"),
      }),
      path: (a) => `/files/${S(a.domainType)}/${S(a.domainIdentifier)}`,
      key: "files",
    },
    {
      name: "ct_get_file_metadata",
      title: "Get a file's metadata",
      description: "Shows the metadata of one file by id (no file content).",
      input: z.object({ fileId: id.describe("The file's id") }),
      path: (a) => `/files/${S(a.fileId)}/meta`,
      key: "file",
    },
    {
      name: "ct_list_appointment_templates",
      title: "List appointment templates",
      description: "Lists every appointment template.",
      input: z.object({}),
      path: () => "/calendars/appointments/templates",
      key: "templates",
    },
    {
      name: "ct_get_appointment_template",
      title: "Get an appointment template",
      description: "Shows one appointment template.",
      input: z.object({ templateId: id.describe("The template's id") }),
      path: (a) => `/calendars/appointments/templates/${S(a.templateId)}`,
      key: "template",
    },
    {
      name: "ct_list_meeting_requests",
      title: "List an appointment's meeting requests",
      description: "Lists the meeting requests of one appointment.",
      input: z.object({
        calendarId: id.describe("The calendar's id"),
        appointmentId: id.describe("The appointment's id"),
      }),
      path: (a) =>
        `/calendars/${S(a.calendarId)}/appointments/${S(a.appointmentId)}/meetingrequests`,
      key: "meetingRequests",
    },
    {
      name: "ct_list_open_meeting_requests",
      title: "List a person's open meeting requests",
      description: "Lists the unanswered meeting invitations of one person.",
      input: z.object({ personId }),
      path: (a) => `/persons/${S(a.personId)}/openmeetingrequests`,
      key: "meetingRequests",
    },
  ]);
  registerPlans(server, deps, [
    {
      name: "ct_answer_meeting_request",
      title: "Plan to answer a meeting request",
      description:
        "Answers one meeting request of an appointment (answer as the API expects it, e.g. accept/decline; see ct_get_operation).",
      input: z.object({
        calendarId: id.describe("The calendar's id"),
        appointmentId: id.describe("The appointment's id"),
        meetingRequestId: id.describe("The meeting request's id"),
        answer: slug.describe("The answer, as the API names it"),
      }),
      method: "POST",
      path: (a) =>
        `/calendars/${S(a.calendarId)}/appointments/${S(a.appointmentId)}/meetingrequests/${S(a.meetingRequestId)}/${S(a.answer)}`,
      guardPath: (a) =>
        `/calendars/${S(a.calendarId)}/appointments/${S(a.appointmentId)}/meetingrequests`,
      summary: (a) =>
        `Answer meeting request ${S(a.meetingRequestId)} with ${S(a.answer)}`,
    },
  ]);
}
