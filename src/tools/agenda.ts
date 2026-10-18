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
const agendaId = id.describe("The agenda template's id");
const itemId = id.describe("The agenda item's id");
const agendaPath = (a: { eventId?: unknown }) =>
  `/events/${S(a.eventId)}/agenda`;

/** Agenda of an event and agenda templates (Agenda tag). Sending an agenda (`POST /agendas/send`, deprecated) is not offered. */
export function registerAgendaTools(server: McpServer, deps: ToolDeps): void {
  registerReads(server, deps, [
    {
      name: "ct_get_event_agenda",
      title: "Get an event's agenda",
      description: "Shows the agenda of one event with its items.",
      input: z.object({ eventId }),
      path: (a) => agendaPath(a),
      key: "agenda",
    },
    {
      name: "ct_list_event_agenda_songs",
      title: "List the songs of an event agenda",
      description: "Lists every song used in the agenda of one event.",
      input: z.object({ eventId }),
      path: (a) => `${agendaPath(a)}/songs`,
      key: "songs",
    },
    {
      name: "ct_list_agenda_templates",
      title: "List agenda templates",
      description: "Lists all agenda templates.",
      input: z.object({}),
      path: () => "/agendatemplates",
      key: "templates",
    },
    {
      name: "ct_get_agenda_template",
      title: "Get an agenda template",
      description: "Shows one agenda template with its items.",
      input: z.object({ agendaId }),
      path: (a) => `/agendatemplates/${S(a.agendaId)}`,
      key: "template",
    },
  ]);
  registerPlans(server, deps, [
    {
      name: "ct_create_agenda_item",
      title: "Plan a new agenda item",
      description:
        "Creates an agenda item on an event's agenda (fields per ct_get_operation, e.g. title, duration).",
      input: z.object({ eventId, fields }),
      method: "POST",
      path: (a) => `${agendaPath(a)}/items`,
      guardPath: (a) => agendaPath(a),
      body: bodyFields,
      summary: (a) => `Create agenda item on event ${S(a.eventId)}`,
    },
    {
      name: "ct_update_agenda_item",
      title: "Plan a change to an agenda item",
      description: "Changes an agenda item of an event.",
      input: z.object({ eventId, itemId, fields }),
      method: "PUT",
      path: (a) => `${agendaPath(a)}/items/${S(a.itemId)}`,
      guardPath: (a) => agendaPath(a),
      body: bodyFields,
      summary: (a) =>
        `Update agenda item ${S(a.itemId)} of event ${S(a.eventId)}`,
    },
    {
      name: "ct_delete_agenda_item",
      title: "Plan to delete an agenda item",
      description:
        "Deletes an agenda item of an event; the preview shows the agenda as it is now.",
      input: z.object({ eventId, itemId }),
      method: "DELETE",
      path: (a) => `${agendaPath(a)}/items/${S(a.itemId)}`,
      guardPath: (a) => agendaPath(a),
      summary: (a) =>
        `Delete agenda item ${S(a.itemId)} of event ${S(a.eventId)}`,
    },
    {
      name: "ct_hide_agenda_item",
      title: "Plan to hide an agenda item",
      description: "Hides an agenda item for this event only.",
      input: z.object({ eventId, itemId }),
      method: "POST",
      path: (a) => `${agendaPath(a)}/items/${S(a.itemId)}/hide`,
      guardPath: (a) => agendaPath(a),
      summary: (a) =>
        `Hide agenda item ${S(a.itemId)} of event ${S(a.eventId)}`,
    },
    {
      name: "ct_unhide_agenda_item",
      title: "Plan to unhide an agenda item",
      description: "Makes a hidden agenda item visible again for this event.",
      input: z.object({ eventId, itemId }),
      method: "POST",
      path: (a) => `${agendaPath(a)}/items/${S(a.itemId)}/unhide`,
      guardPath: (a) => agendaPath(a),
      summary: (a) =>
        `Unhide agenda item ${S(a.itemId)} of event ${S(a.eventId)}`,
    },
    {
      name: "ct_lock_agenda",
      title: "Plan to lock an event agenda",
      description: "Locks the agenda of an event against changes.",
      input: z.object({ eventId }),
      method: "POST",
      path: (a) => `${agendaPath(a)}/lock`,
      guardPath: (a) => agendaPath(a),
      summary: (a) => `Lock the agenda of event ${S(a.eventId)}`,
    },
    {
      name: "ct_unlock_agenda",
      title: "Plan to unlock an event agenda",
      description: "Unlocks the agenda of an event.",
      input: z.object({ eventId }),
      method: "POST",
      path: (a) => `${agendaPath(a)}/unlock`,
      guardPath: (a) => agendaPath(a),
      summary: (a) => `Unlock the agenda of event ${S(a.eventId)}`,
    },
  ]);
}
