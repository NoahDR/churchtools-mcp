import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  bodyFields,
  domainType,
  fields,
  id,
  registerPlans,
  registerReads,
  type ToolDeps,
  S,
} from "./api-tools.js";

const domainId = id.describe("The domain object's id");
const personId = id.describe("The person's id");

/** Tags, notes and person relationships (Tag/Note/Person tags). */
export function registerTagNoteTools(server: McpServer, deps: ToolDeps): void {
  registerReads(server, deps, [
    {
      name: "ct_list_tags",
      title: "List tags of a domain type",
      description:
        "Lists the tags defined for a domain type (person, group, song, …).",
      input: z.object({ domainType }),
      path: (a) => `/tags/${S(a.domainType)}`,
      key: "tags",
    },
    {
      name: "ct_list_object_tags",
      title: "List an object's tags",
      description: "Lists the tags set on one domain object.",
      input: z.object({ domainType, domainId }),
      path: (a) => `/tags/${S(a.domainType)}/${S(a.domainId)}`,
      key: "tags",
    },
    {
      name: "ct_list_notes",
      title: "List an object's notes",
      description: "Lists the notes on one domain object.",
      input: z.object({ domainType, domainId }),
      path: (a) => `/notes/${S(a.domainType)}/${S(a.domainId)}`,
      key: "notes",
    },
    {
      name: "ct_list_relationships",
      title: "List a person's relationships",
      description: "Lists every relationship of one person.",
      input: z.object({ personId }),
      path: (a) => `/persons/${S(a.personId)}/relationships`,
      key: "relationships",
    },
    {
      name: "ct_list_relationship_types",
      title: "List relationship types",
      description: "Lists every relationship type.",
      input: z.object({}),
      path: () => "/person/relationshiptypes",
      key: "relationshipTypes",
    },
  ]);
  registerPlans(server, deps, [
    {
      name: "ct_create_tag",
      title: "Plan a new tag",
      description: "Creates a tag for a domain type (body: a name).",
      input: z.object({ domainType, name: z.string().trim().min(1).max(255) }),
      method: "POST",
      path: (a) => `/tags/${S(a.domainType)}`,
      guardPath: (a) => `/tags/${S(a.domainType)}`,
      body: (a) => ({ name: a.name }),
      summary: (a) => `Create tag ${S(a.name)} for ${S(a.domainType)}`,
    },
    {
      name: "ct_add_tag",
      title: "Plan to add a tag to an object",
      description: "Adds a tag (by name) to one domain object.",
      input: z.object({
        domainType,
        domainId,
        name: z.string().trim().min(1).max(255),
      }),
      method: "POST",
      path: (a) => `/tags/${S(a.domainType)}/${S(a.domainId)}`,
      guardPath: (a) => `/tags/${S(a.domainType)}/${S(a.domainId)}`,
      body: (a) => ({ name: a.name }),
      summary: (a) =>
        `Add tag ${S(a.name)} to ${S(a.domainType)} ${S(a.domainId)}`,
    },
    {
      name: "ct_remove_tag",
      title: "Plan to remove a tag from an object",
      description:
        "Removes one tag from one domain object; the preview shows the object's tags as they are now.",
      input: z.object({
        domainType,
        domainId,
        tagId: id.describe("The tag's id"),
      }),
      method: "DELETE",
      path: (a) => `/tags/${S(a.domainType)}/${S(a.domainId)}/${S(a.tagId)}`,
      guardPath: (a) => `/tags/${S(a.domainType)}/${S(a.domainId)}`,
      summary: (a) =>
        `Remove tag ${S(a.tagId)} from ${S(a.domainType)} ${S(a.domainId)}`,
    },
    {
      name: "ct_delete_tag",
      title: "Plan to delete a tag",
      description: "Deletes a tag definition entirely.",
      input: z.object({ tagId: id.describe("The tag's id") }),
      method: "DELETE",
      path: (a) => `/tags/${S(a.tagId)}`,
      guardPath: (a) => `/tags/${S(a.tagId)}`,
      summary: (a) => `Delete tag ${S(a.tagId)}`,
    },
    {
      name: "ct_add_note",
      title: "Plan a new note",
      description:
        "Adds a note to one domain object (the API requires text and securityLevelId).",
      input: z.object({ domainType, domainId, fields }),
      method: "POST",
      path: (a) => `/notes/${S(a.domainType)}/${S(a.domainId)}`,
      guardPath: (a) => `/notes/${S(a.domainType)}/${S(a.domainId)}`,
      body: bodyFields,
      summary: (a) => `Add note to ${S(a.domainType)} ${S(a.domainId)}`,
    },
    {
      name: "ct_update_note",
      title: "Plan a change to a note",
      description: "Changes a note on one domain object.",
      input: z.object({
        domainType,
        domainId,
        noteId: id.describe("The note's id"),
        fields,
      }),
      method: "PUT",
      path: (a) => `/notes/${S(a.domainType)}/${S(a.domainId)}/${S(a.noteId)}`,
      guardPath: (a) => `/notes/${S(a.domainType)}/${S(a.domainId)}`,
      body: bodyFields,
      summary: (a) =>
        `Update note ${S(a.noteId)} on ${S(a.domainType)} ${S(a.domainId)}`,
    },
    {
      name: "ct_delete_note",
      title: "Plan to delete a note",
      description:
        "Deletes a note; the preview shows the object's notes as they are now.",
      input: z.object({
        domainType,
        domainId,
        noteId: id.describe("The note's id"),
      }),
      method: "DELETE",
      path: (a) => `/notes/${S(a.domainType)}/${S(a.domainId)}/${S(a.noteId)}`,
      guardPath: (a) => `/notes/${S(a.domainType)}/${S(a.domainId)}`,
      summary: (a) =>
        `Delete note ${S(a.noteId)} on ${S(a.domainType)} ${S(a.domainId)}`,
    },
    {
      name: "ct_create_relationship",
      title: "Plan a new person relationship",
      description:
        "Creates a relationship between two persons (type ids: ct_list_relationship_types).",
      input: z.object({
        personId,
        otherPersonId: id.describe("The other person's id"),
        relationshipTypeId: id.describe("The relationship type's id"),
      }),
      method: "POST",
      path: (a) => `/persons/${S(a.personId)}/relationships`,
      guardPath: (a) => `/persons/${S(a.personId)}/relationships`,
      body: (a) => ({
        otherPersonId: a.otherPersonId,
        relationshipTypeId: a.relationshipTypeId,
      }),
      summary: (a) =>
        `Relate person ${S(a.personId)} to person ${S(a.otherPersonId)}`,
    },
    {
      name: "ct_delete_relationship",
      title: "Plan to delete a person relationship",
      description:
        "Deletes one relationship of a person; the preview shows the person's relationships as they are now.",
      input: z.object({
        personId,
        relationshipId: id.describe("The relationship's id"),
      }),
      method: "DELETE",
      path: (a) =>
        `/persons/${S(a.personId)}/relationships/${S(a.relationshipId)}`,
      guardPath: (a) => `/persons/${S(a.personId)}/relationships`,
      summary: (a) =>
        `Delete relationship ${S(a.relationshipId)} of person ${S(a.personId)}`,
    },
  ]);
}
