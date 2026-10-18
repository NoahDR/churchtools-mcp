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

const eventId = id.describe("The event's id");
const factId = id.describe("The fact's id");

/** Event facts (Fact tag). Exporting facts (`POST /events/facts/export`) is not offered. */
export function registerFactTools(server: McpServer, deps: ToolDeps): void {
  registerReads(server, deps, [
    {
      name: "ct_list_facts",
      title: "List fact definitions",
      description: "Lists every fact definition.",
      input: z.object({}),
      path: () => "/facts",
      key: "facts",
    },
    {
      name: "ct_get_fact",
      title: "Get a fact definition",
      description: "Shows one fact definition.",
      input: z.object({ factId }),
      path: (a) => `/facts/${S(a.factId)}`,
      key: "fact",
    },
    {
      name: "ct_list_event_facts",
      title: "List an event's facts",
      description: "Lists the fact values recorded for one event.",
      input: z.object({ eventId }),
      path: (a) => `/events/${S(a.eventId)}/facts`,
      key: "facts",
    },
    {
      name: "ct_get_event_fact",
      title: "Get an event's fact",
      description: "Shows one fact value of one event.",
      input: z.object({ eventId, factId }),
      path: (a) => `/events/${S(a.eventId)}/facts/${S(a.factId)}`,
      key: "fact",
    },
  ]);
  registerPlans(server, deps, [
    {
      name: "ct_set_event_fact",
      title: "Plan to set an event fact",
      description: "Creates or updates the value of one fact for one event.",
      input: z.object({
        eventId,
        factId,
        value: z
          .union([z.number(), z.string()])
          .describe("The fact's value (a number for numeric facts)"),
      }),
      method: "PUT",
      path: (a) => `/events/${S(a.eventId)}/facts/${S(a.factId)}`,
      guardPath: (a) => `/events/${S(a.eventId)}/facts`,
      body: (a) => ({ value: a.value }),
      summary: (a) => `Set fact ${S(a.factId)} of event ${S(a.eventId)}`,
    },
    {
      name: "ct_create_fact",
      title: "Plan a new fact definition",
      description: "Creates a fact definition (fields per ct_get_operation).",
      input: z.object({ fields }),
      method: "POST",
      path: () => "/facts",
      body: bodyFields,
      summary: () => "Create a fact definition",
    },
    {
      name: "ct_update_fact",
      title: "Plan a change to a fact definition",
      description:
        "Changes only the fields of a fact definition whose value differs.",
      input: z.object({ factId, fields }),
      method: "PUT",
      path: (a) => `/facts/${S(a.factId)}`,
      guardPath: (a) => `/facts/${S(a.factId)}`,
      body: bodyFields,
      changed: true,
      summary: (a) => `Update fact definition ${S(a.factId)}`,
    },
    {
      name: "ct_delete_fact",
      title: "Plan to delete a fact definition",
      description:
        "Deletes a fact definition; the preview shows it as it is now.",
      input: z.object({ factId }),
      method: "DELETE",
      path: (a) => `/facts/${S(a.factId)}`,
      guardPath: (a) => `/facts/${S(a.factId)}`,
      summary: (a) => `Delete fact definition ${S(a.factId)}`,
    },
    {
      name: "ct_delete_event_fact",
      title: "Plan to delete an event fact",
      description:
        "Deletes one fact value of an event; the preview shows the event's facts as they are now.",
      input: z.object({ eventId, factId }),
      method: "DELETE",
      path: (a) => `/events/${S(a.eventId)}/facts/${S(a.factId)}`,
      guardPath: (a) => `/events/${S(a.eventId)}/facts`,
      summary: (a) => `Delete fact ${S(a.factId)} of event ${S(a.eventId)}`,
    },
  ]);
}
