import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  bodyFields,
  fields,
  id,
  registerPlans,
  registerReads,
  type ToolDeps,
  S,
} from "./api-tools.js";

const personId = id.describe("The person's id");
const absenceId = id.describe("The absence's id");
const base = (a: { personId?: unknown }) =>
  `/persons/${S(a.personId)}/absences`;

/** Absences of persons and groups (Absence tag). */
export function registerAbsenceTools(server: McpServer, deps: ToolDeps): void {
  registerReads(server, deps, [
    {
      name: "ct_list_person_absences",
      title: "List a person's absences",
      description: "Lists every absence of one person.",
      input: z.object({ personId }),
      path: (a) => base(a),
      key: "absences",
    },
    {
      name: "ct_get_person_absence",
      title: "Get a person's absence",
      description: "Shows one absence of one person.",
      input: z.object({ personId, absenceId }),
      path: (a) => `${base(a)}/${S(a.absenceId)}`,
      key: "absence",
    },
    {
      name: "ct_list_group_absences",
      title: "List a group's absences",
      description: "Lists the absences of the persons in one group.",
      input: z.object({ groupId: id.describe("The group's id") }),
      path: (a) => `/groups/${S(a.groupId)}/absences`,
      key: "absences",
    },
  ]);
  registerPlans(server, deps, [
    {
      name: "ct_create_absence",
      title: "Plan a new absence",
      description:
        "Creates an absence (the API requires comment, absenceReasonId and startDate or start/end times; see ct_get_operation).",
      input: z.object({ personId, fields }),
      method: "POST",
      path: (a) => base(a),
      guardPath: (a) => base(a),
      body: bodyFields,
      summary: (a) => `Create absence for person ${S(a.personId)}`,
    },
    {
      name: "ct_update_absence",
      title: "Plan a change to an absence",
      description: "Changes only the fields of an absence whose value differs.",
      input: z.object({ personId, absenceId, fields }),
      method: "PUT",
      path: (a) => `${base(a)}/${S(a.absenceId)}`,
      guardPath: (a) => `${base(a)}/${S(a.absenceId)}`,
      body: bodyFields,
      changed: true,
      summary: (a) =>
        `Update absence ${S(a.absenceId)} of person ${S(a.personId)}`,
    },
    {
      name: "ct_delete_absence",
      title: "Plan to delete an absence",
      description: "Deletes an absence; the preview shows it as it is now.",
      input: z.object({ personId, absenceId }),
      method: "DELETE",
      path: (a) => `${base(a)}/${S(a.absenceId)}`,
      guardPath: (a) => `${base(a)}/${S(a.absenceId)}`,
      summary: (a) =>
        `Delete absence ${S(a.absenceId)} of person ${S(a.personId)}`,
    },
  ]);
}
