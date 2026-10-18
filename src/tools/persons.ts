import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { errorText, parse } from "../ct/client.js";
import { type Session, loginRequired } from "../ct/session.js";
import { type Plans, changedOnly, readGuarded } from "../plans.js";
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

const personId = id.describe("The person's id");
const name = z.string().trim().regex(/\S/, "must not be blank");

/** A list shows these fields only; every other personal field stays out. */
const compactPerson = z.object({
  id: z.number(),
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  email: z.string().nullish(),
  statusId: z.number().nullish(),
});
const personRecord = z.object({ data: z.record(z.string(), z.unknown()) });

const personName = z
  .object({ firstName: z.string().nullish(), lastName: z.string().nullish() })
  .catch({});

/** "person 12 (Anna Muster)", or "person 12" when the record has no name. */
function personLabel(personId: number, record: unknown): string {
  const { firstName, lastName } = personName.parse(record);
  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  return fullName ? `person ${personId} (${fullName})` : `person ${personId}`;
}

const searchInput = z.object({
  query: z
    .string()
    .optional()
    .describe("Part of a first name, last name or nickname"),
  email: z.string().optional().describe("An email address or part of one"),
  status_ids: z
    .array(z.number().int().nonnegative())
    .optional()
    .describe("Only persons with these status ids; 0 is the status unknown"),
  is_archived: z
    .boolean()
    .optional()
    .describe("Only archived or only active persons"),
  page: page.optional(),
  limit: limit("Persons"),
});

/** Registers the person tools: reads answer at once, writes return a plan for ct_execute_plan. */
export function registerPersonTools(
  server: McpServer,
  { session, plans }: { session: Pick<Session, "use">; plans: Plans },
): void {
  /** The duplicate check also filters by `firstName` and `lastName`, which the tool does not offer. */
  async function search(
    input: z.infer<typeof searchInput> & {
      firstName?: string;
      lastName?: string;
    },
  ) {
    const { status_ids, ...rest } = input;
    const query = { ...rest, "status_ids[]": status_ids };
    const answer = await session.use((client) =>
      client.request("GET", "/persons", { query }),
    );
    const { data, ...pagination } = parseList(
      compactPerson,
      answer,
      "/persons",
    );
    return { persons: data, ...pagination };
  }

  /** A failed check is noted, not thrown: it must not block the preview. */
  async function possibleDuplicates(firstName: string, lastName: string) {
    try {
      return (await search({ firstName, lastName })).persons;
    } catch (error) {
      if (error instanceof Error && error.message === loginRequired)
        throw error;
      return `not checked: ${errorText(error)}`;
    }
  }

  server.registerTool(
    "ct_search_persons",
    {
      title: "Search ChurchTools persons",
      description:
        "Finds persons by text, email, status or archive state. Lists only id, first and last name, email and status id; use ct_get_person for the whole record.",
      inputSchema: searchInput,
      annotations: read,
    },
    (input) => toolResult(() => search(input)),
  );

  server.registerTool(
    "ct_get_person",
    {
      title: "Get a ChurchTools person",
      description: "Shows the whole record of one person.",
      inputSchema: z.object({ personId }),
      annotations: read,
    },
    ({ personId }) =>
      toolResult(async () => {
        const path = `/persons/${personId}`;
        const answer = await session.use((client) =>
          client.request("GET", path),
        );
        return parse(personRecord, answer, path).data;
      }),
  );

  server.registerTool(
    "ct_create_person",
    {
      title: "Plan a new ChurchTools person",
      description:
        "Writes nothing: returns a plan to create a person, with persons of the same name as possible duplicates. Department ids come from GET /person/masterdata (ct_api_request). Most instances also demand statusId and campusId in fields, both from the same masterdata; an instance that makes the privacy agreement mandatory also demands privacyPolicyAgreementTypeId, privacyPolicyAgreementWhoId and privacyPolicyAgreementDate, which only the user can state. If ChurchTools refuses a duplicate, the result names duplicatePersonId.",
      inputSchema: z.object({
        firstName: name,
        lastName: name,
        departmentIds: z
          .array(id)
          .min(1)
          .describe("At least one department id"),
        fields: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Further fields of the person, e.g. email, mobile, birthday",
          ),
      }),
      annotations: plan,
    },
    ({ firstName, lastName, departmentIds, fields }) =>
      toolResult(async () => {
        const body = {
          ...withoutForce(fields),
          firstName,
          lastName,
          departmentIds,
        };
        const duplicates = await possibleDuplicates(firstName, lastName);
        const { token, preview } = plans.createPlan({
          summary: `Create person ${firstName} ${lastName}`,
          changes: [{ method: "POST", path: "/persons", body }],
          guards: [],
        });
        return {
          token,
          preview: { ...preview, possibleDuplicates: duplicates },
        };
      }),
  );

  server.registerTool(
    "ct_update_person",
    {
      title: "Plan a change to a ChurchTools person",
      description:
        "Writes nothing: returns a plan that patches only the fields whose value changes; null clears a field.",
      inputSchema: z.object({
        personId,
        fields: z
          .record(z.string(), z.unknown())
          .refine(
            (f) => Object.keys(f).length > 0,
            "must name at least one field",
          )
          .describe("The fields to set, e.g. { email: 'a@b.org' }"),
      }),
      annotations: plan,
    },
    ({ personId, fields }) =>
      toolResult(async () => {
        if (Object.keys(withoutForce(fields)).length === 0) {
          throw new Error(
            "Name a field to change: force alone changes nothing",
          );
        }
        const path = `/persons/${personId}`;
        const { guard, before } = await readGuarded(session, path);
        const body = changedOnly(before, withoutForce(fields));
        if (Object.keys(body).length === 0) {
          throw new Error(
            `No change: person ${personId} already has these values`,
          );
        }
        return plans.createPlan({
          summary: `Update ${personLabel(personId, before)}`,
          changes: [{ method: "PATCH", path, body, before }],
          guards: [guard],
        });
      }),
  );

  server.registerTool(
    "ct_delete_person",
    {
      title: "Plan to delete a ChurchTools person",
      description:
        "Writes nothing: returns a plan to delete a person; the preview shows the whole record, as a delete cannot be undone.",
      inputSchema: z.object({ personId }),
      annotations: plan,
    },
    ({ personId }) =>
      toolResult(async () => {
        const path = `/persons/${personId}`;
        const { guard, before } = await readGuarded(session, path);
        return plans.createPlan({
          summary: `Delete ${personLabel(personId, before)}`,
          changes: [{ method: "DELETE", path, before }],
          guards: [guard],
        });
      }),
  );
}
