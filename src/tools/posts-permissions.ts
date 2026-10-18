import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  domainType,
  id,
  registerReads,
  type ToolDeps,
  S,
} from "./api-tools.js";

/**
 * Posts/comments (read-only — sending posts, bulk letters and newsletters have no tool) and
 * permissions/admin (read-only — no config, sync, SSO or permission writes).
 * Event posts come through the post list/search filtered by the caller.
 */
export function registerPostPermissionTools(
  server: McpServer,
  deps: ToolDeps,
): void {
  registerReads(server, deps, [
    {
      name: "ct_list_posts",
      title: "List posts",
      description: "Lists posts (reading only; writing posts has no tool).",
      input: z.object({ page: id.optional(), limit: id.max(500).optional() }),
      path: () => "/posts",
      query: (a) => ({ page: a.page as number, limit: a.limit as number }),
      key: "posts",
    },
    {
      name: "ct_get_post",
      title: "Get a post",
      description: "Shows one post.",
      input: z.object({ postId: id.describe("The post's id") }),
      path: (a) => `/posts/${S(a.postId)}`,
      key: "post",
    },
    {
      name: "ct_list_post_comments",
      title: "List a post's comments",
      description:
        "Lists the comments of one post (this also covers comments on event posts).",
      input: z.object({ postId: id.describe("The post's id") }),
      path: (a) => `/posts/${S(a.postId)}/comments`,
      key: "comments",
    },
    {
      name: "ct_search_posts",
      title: "Search posts",
      description: "Searches posts by text.",
      input: z.object({
        query: z.string().trim().min(1).describe("The search term"),
      }),
      path: () => "/post/search",
      query: (a) => ({ query: a.query as string }),
      key: "posts",
    },
    {
      name: "ct_list_person_posts",
      title: "List a person's posts",
      description: "Lists the posts authored by one person.",
      input: z.object({ personId: id.describe("The person's id") }),
      path: (a) => `/persons/${S(a.personId)}/posts`,
      key: "posts",
    },
    {
      name: "ct_list_permission_definitions",
      title: "List permission definitions",
      description:
        "Lists every permission definition (reading only; changing permissions has no tool).",
      input: z.object({}),
      path: () => "/permissions/definitions",
      key: "definitions",
    },
    {
      name: "ct_get_my_permissions",
      title: "Get the current user's global permissions",
      description: "Lists the global permissions of the logged-in user.",
      input: z.object({}),
      path: () => "/permissions/global",
      key: "permissions",
    },
    {
      name: "ct_list_object_permissions",
      title: "List an object's permissions",
      description: "Lists the permissions set on one domain object.",
      input: z.object({
        domainType,
        domainId: id.describe("The domain object's id"),
      }),
      path: (a) => `/permissions/${S(a.domainType)}/${S(a.domainId)}`,
      key: "permissions",
    },
    {
      name: "ct_get_permission_origins",
      title: "Explain a person's permissions",
      description:
        "Explains where a person's global permissions come from (permission origins).",
      input: z.object({ personId: id.describe("The person's id") }),
      path: (a) => `/permissions/origins/global/persons/${S(a.personId)}`,
      key: "origins",
    },
    {
      name: "ct_get_internal_permission_origins",
      title: "Explain a person's group-internal permissions",
      description:
        "Explains where a person's group-internal permissions come from.",
      input: z.object({ personId: id.describe("The person's id") }),
      path: (a) => `/permissions/origins/internal/persons/${S(a.personId)}`,
      key: "origins",
    },
    {
      name: "ct_list_security_levels",
      title: "List security levels",
      description: "Lists every security level (reading only).",
      input: z.object({}),
      path: () => "/securitylevels",
      key: "securityLevels",
    },
  ]);
}
