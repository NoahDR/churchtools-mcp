import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { registerReads, type ToolDeps } from "./api-tools.js";

/** Read-only master-data bundle (MasterData/Department/Status/Campus/Group tags). The deprecated `GET /masterdata/person` is not used; `GET /person/masterdata` replaces it. No finance master data. */
export function registerMasterdataTools(
  server: McpServer,
  deps: ToolDeps,
): void {
  registerReads(server, deps, [
    {
      name: "ct_get_person_masterdata",
      title: "Get person & group master data",
      description:
        "Shows the People & Groups reference catalogs (departments, statuses, campuses, roles and more).",
      input: z.object({}),
      path: () => "/person/masterdata",
      key: "masterdata",
    },
    {
      name: "ct_get_event_masterdata",
      title: "Get event master data",
      description: "Shows the master data of the Events module.",
      input: z.object({}),
      path: () => "/event/masterdata",
      key: "masterdata",
    },
    {
      name: "ct_list_departments",
      title: "List departments",
      description: "Lists every department.",
      input: z.object({}),
      path: () => "/departments",
      key: "departments",
    },
    {
      name: "ct_list_statuses",
      title: "List person statuses",
      description: "Lists every person status.",
      input: z.object({}),
      path: () => "/statuses",
      key: "statuses",
    },
    {
      name: "ct_list_campuses",
      title: "List campuses",
      description: "Lists every campus/site.",
      input: z.object({}),
      path: () => "/campuses",
      key: "campuses",
    },
    {
      name: "ct_list_group_roles",
      title: "List group roles",
      description:
        "Lists every group role (per-group roles: GET /groups/{groupId}/roles via ct_api_request).",
      input: z.object({}),
      path: () => "/group/roles",
      key: "roles",
    },
  ]);
}
