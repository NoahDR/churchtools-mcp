import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  bodyFields,
  fields,
  id,
  optionalFields,
  registerPlans,
  registerReads,
  type ToolDeps,
  S,
} from "./api-tools.js";

const eventId = id.describe("The event's id");
const personId = id.describe("The person's id");
const serviceId = id.describe("The service's id");
const requestId = id.describe("The service/exchange request's id");

/**
 * Modern service requests (Event/Service tags). `ct_assign_event_service` already uses the
 * modern `PUT /events/{eventId}/servicerequests/{id}` path; the deprecated `eventservices`
 * writes stay only in the pre-existing external-helper tool (see PR notes).
 */
export function registerModernServiceTools(
  server: McpServer,
  deps: ToolDeps,
): void {
  registerReads(server, deps, [
    {
      name: "ct_list_service_groups",
      title: "List service groups",
      description: "Lists every service group.",
      input: z.object({}),
      path: () => "/servicegroups",
      key: "serviceGroups",
    },
    {
      name: "ct_get_service_group",
      title: "Get a service group",
      description: "Shows one service group.",
      input: z.object({ serviceGroupId: id }),
      path: (a) => `/servicegroups/${S(a.serviceGroupId)}`,
      key: "serviceGroup",
    },
    {
      name: "ct_get_service",
      title: "Get a service",
      description: "Shows one service (all services: ct_list_services).",
      input: z.object({ serviceId }),
      path: (a) => `/services/${S(a.serviceId)}`,
      key: "service",
    },
    {
      name: "ct_list_possible_persons",
      title: "List possible persons for a service",
      description:
        "Lists the persons ChurchTools considers possible for one service of one event.",
      input: z.object({ eventId, serviceId }),
      path: (a) =>
        `/events/${S(a.eventId)}/services/${S(a.serviceId)}/possiblepersons`,
      key: "persons",
    },
    {
      name: "ct_list_person_service_requests",
      title: "List a person's service requests",
      description: "Lists every service request of one person.",
      input: z.object({ personId }),
      path: (a) => `/persons/${S(a.personId)}/servicerequests`,
      key: "serviceRequests",
    },
    {
      name: "ct_get_person_service_request",
      title: "Get a person's service request",
      description: "Shows one service request of one person.",
      input: z.object({ personId, requestId }),
      path: (a) =>
        `/persons/${S(a.personId)}/servicerequests/${S(a.requestId)}`,
      key: "serviceRequest",
    },
    {
      name: "ct_list_exchange_requests",
      title: "List a person's service exchange requests",
      description: "Lists every service exchange request of one person.",
      input: z.object({ personId }),
      path: (a) => `/persons/${S(a.personId)}/exchangerequests`,
      key: "exchangeRequests",
    },
    {
      name: "ct_list_exchange_candidates",
      title: "List candidates for a service exchange",
      description:
        "Lists candidate persons for exchanging one service of one event.",
      input: z.object({ personId, eventId, serviceId }),
      path: (a) =>
        `/persons/${S(a.personId)}/events/${S(a.eventId)}/services/${S(a.serviceId)}/exchangerequests/candidates`,
      key: "candidates",
    },
  ]);
  const eventGuard = (a: { eventId?: unknown }) => `/events/${S(a.eventId)}`;
  registerPlans(server, deps, [
    {
      name: "ct_accept_service_request",
      title: "Plan to accept a service request",
      description:
        "Accepts one service request of an event (modern servicerequests path).",
      input: z.object({ eventId, requestId, fields: optionalFields }),
      method: "POST",
      path: (a) =>
        `/events/${S(a.eventId)}/servicerequests/${S(a.requestId)}/accept`,
      guardPath: eventGuard,
      body: (a) => a.fields ?? {},
      summary: (a) =>
        `Accept service request ${S(a.requestId)} of event ${S(a.eventId)}`,
    },
    {
      name: "ct_decline_service_request",
      title: "Plan to decline a service request",
      description:
        "Declines one service request of an event, which frees the assignment.",
      input: z.object({ eventId, requestId, fields: optionalFields }),
      method: "POST",
      path: (a) =>
        `/events/${S(a.eventId)}/servicerequests/${S(a.requestId)}/decline`,
      guardPath: eventGuard,
      body: (a) => a.fields ?? {},
      summary: (a) =>
        `Decline service request ${S(a.requestId)} of event ${S(a.eventId)}`,
    },
    {
      name: "ct_undo_service_request",
      title: "Plan to undo a service request action",
      description: "Undoes the last action on one service request of an event.",
      input: z.object({ eventId, requestId }),
      method: "POST",
      path: (a) =>
        `/events/${S(a.eventId)}/servicerequests/${S(a.requestId)}/undo`,
      guardPath: eventGuard,
      summary: (a) =>
        `Undo service request ${S(a.requestId)} of event ${S(a.eventId)}`,
    },
    {
      name: "ct_update_service_request",
      title: "Plan a change to a service request",
      description:
        "Changes a service request (fields per ct_get_operation: exactly one of personId/name, plus isAccepted/comment).",
      input: z.object({ eventId, requestId, fields }),
      method: "PUT",
      path: (a) => `/events/${S(a.eventId)}/servicerequests/${S(a.requestId)}`,
      guardPath: eventGuard,
      body: bodyFields,
      summary: (a) =>
        `Update service request ${S(a.requestId)} of event ${S(a.eventId)}`,
    },
    {
      name: "ct_create_exchange_request",
      title: "Plan a new service exchange request",
      description:
        "Creates an exchange request for one service of one event (fields per ct_get_operation).",
      input: z.object({ personId, eventId, serviceId, fields }),
      method: "POST",
      path: (a) =>
        `/persons/${S(a.personId)}/events/${S(a.eventId)}/services/${S(a.serviceId)}/exchangerequests`,
      guardPath: (a) => `/persons/${S(a.personId)}/exchangerequests`,
      body: bodyFields,
      summary: (a) =>
        `Create exchange request of person ${S(a.personId)} for service ${S(a.serviceId)}`,
    },
    {
      name: "ct_accept_exchange_request",
      title: "Plan to accept a service exchange request",
      description: "Accepts one exchange request of a person.",
      input: z.object({ personId, requestId, fields: optionalFields }),
      method: "PUT",
      path: (a) =>
        `/persons/${S(a.personId)}/exchangerequests/${S(a.requestId)}`,
      guardPath: (a) => `/persons/${S(a.personId)}/exchangerequests`,
      body: (a) => a.fields ?? {},
      summary: (a) =>
        `Accept exchange request ${S(a.requestId)} of person ${S(a.personId)}`,
    },
    {
      name: "ct_decline_exchange_request",
      title: "Plan to decline a service exchange request",
      description: "Declines (deletes) one exchange request of a person.",
      input: z.object({ personId, requestId }),
      method: "DELETE",
      path: (a) =>
        `/persons/${S(a.personId)}/exchangerequests/${S(a.requestId)}`,
      guardPath: (a) => `/persons/${S(a.personId)}/exchangerequests`,
      summary: (a) =>
        `Decline exchange request ${S(a.requestId)} of person ${S(a.personId)}`,
    },
  ]);
}
