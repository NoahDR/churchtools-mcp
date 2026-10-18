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

const bookingId = id.describe("The booking's id");
/** Booking conflicts for a would-be booking; a failure is noted in the preview, never hidden. */
const conflicts = async (
  body: unknown,
  post: (path: string, body: unknown) => Promise<unknown>,
) => {
  try {
    return { bookingConflicts: await post("/bookings/conflicts", body) };
  } catch (error) {
    return {
      bookingConflicts: `not checked: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

/** Resources and bookings (Resource tag). Splitting a booking (`POST /bookings/{id}`) is not offered. */
export function registerResourceTools(server: McpServer, deps: ToolDeps): void {
  registerReads(server, deps, [
    {
      name: "ct_get_resource_masterdata",
      title: "Get resource master data",
      description:
        "Shows the resource master data: resources, types and booking statuses.",
      input: z.object({}),
      path: () => "/resource/masterdata",
      key: "masterdata",
    },
    {
      name: "ct_list_bookings",
      title: "List bookings",
      description:
        "Lists bookings for the given resource ids (the API requires at least one).",
      input: z.object({
        resource_ids: z.array(id).min(1).describe("At least one resource id"),
        person_id: id.optional().describe("Only bookings of this person"),
        page: id.optional(),
        limit: id.max(500).optional(),
      }),
      path: () => "/bookings",
      query: (a) => ({
        "resource_ids[]": a.resource_ids as number[],
        person_id: a.person_id as number,
        page: a.page as number,
        limit: a.limit as number,
      }),
      key: "bookings",
    },
    {
      name: "ct_get_booking",
      title: "Get a booking",
      description: "Shows one booking.",
      input: z.object({ bookingId }),
      path: (a) => `/bookings/${S(a.bookingId)}`,
      key: "booking",
    },
    {
      name: "ct_check_booking_conflicts",
      title: "Check booking conflicts",
      description:
        "Only determines conflicts for a would-be booking (the API's conflict check creates nothing) and lists them; it books nothing.",
      input: z.object({ fields }),
      path: () => "/bookings/conflicts",
      viaPost: (a) => a.fields,
      key: "conflicts",
    },
  ]);
  registerPlans(server, deps, [
    {
      name: "ct_create_booking",
      title: "Plan a new booking",
      description:
        "Creates a booking; the preview includes the API's conflict check for these fields.",
      input: z.object({ fields }),
      method: "POST",
      path: () => "/bookings",
      body: bodyFields,
      extra: (a, post) => conflicts(a.fields, post),
      summary: () => "Create a booking",
    },
    {
      name: "ct_update_booking",
      title: "Plan a change to a booking",
      description:
        "Changes a booking; the preview includes the conflict check for the changed fields.",
      input: z.object({ bookingId, fields }),
      method: "PUT",
      path: (a) => `/bookings/${S(a.bookingId)}`,
      guardPath: (a) => `/bookings/${S(a.bookingId)}`,
      body: bodyFields,
      extra: (a, post) => conflicts(a.fields, post),
      summary: (a) => `Update booking ${S(a.bookingId)}`,
    },
    {
      name: "ct_delete_booking",
      title: "Plan to delete a booking",
      description: "Deletes a booking; the preview shows it as it is now.",
      input: z.object({ bookingId }),
      method: "DELETE",
      path: (a) => `/bookings/${S(a.bookingId)}`,
      guardPath: (a) => `/bookings/${S(a.bookingId)}`,
      summary: (a) => `Delete booking ${S(a.bookingId)}`,
    },
    {
      name: "ct_answer_booking",
      title: "Plan to answer a booking request",
      description: "Sets a booking's status: approve, reject or reset.",
      input: z.object({
        bookingId,
        answer: z.enum(["approve", "reject", "reset"]),
      }),
      method: "PUT",
      path: (a) => `/bookings/${S(a.bookingId)}/${S(a.answer)}`,
      guardPath: (a) => `/bookings/${S(a.bookingId)}`,
      summary: (a) => `${S(a.answer)} booking ${S(a.bookingId)}`,
    },
  ]);
}
