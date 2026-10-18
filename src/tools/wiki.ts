import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  bodyFields,
  fields,
  id,
  registerPlans,
  registerReads,
  slug,
  type ToolDeps,
  S,
} from "./api-tools.js";

const wikiCategoryId = id.describe("The wiki category's id");
const identifier = slug.describe(
  "The wiki page's identifier (title-based, no slash)",
);

/** Wiki (Wiki tag): categories, pages, versions and full-text search. */
export function registerWikiTools(server: McpServer, deps: ToolDeps): void {
  registerReads(server, deps, [
    {
      name: "ct_list_wiki_categories",
      title: "List wiki categories",
      description: "Lists every wiki category.",
      input: z.object({}),
      path: () => "/wiki/categories",
      key: "categories",
    },
    {
      name: "ct_list_wiki_pages",
      title: "List wiki pages",
      description: "Lists the wiki pages of one category.",
      input: z.object({ wikiCategoryId }),
      path: (a) => `/wiki/categories/${S(a.wikiCategoryId)}/pages`,
      key: "pages",
    },
    {
      name: "ct_get_wiki_page",
      title: "Get a wiki page",
      description: "Shows one wiki page.",
      input: z.object({ wikiCategoryId, identifier }),
      path: (a) =>
        `/wiki/categories/${S(a.wikiCategoryId)}/pages/${S(a.identifier)}`,
      key: "page",
    },
    {
      name: "ct_search_wiki",
      title: "Search the wiki",
      description: "Full-text search across wiki pages.",
      input: z.object({
        query: z.string().trim().min(1).describe("The search term"),
        wiki_category_ids: z
          .array(id)
          .optional()
          .describe("Only these wiki categories"),
      }),
      path: () => "/wiki/search",
      query: (a) => ({
        query: a.query as string,
        "wiki_category_ids[]": a.wiki_category_ids as number[],
      }),
      key: "results",
    },
    {
      name: "ct_list_wiki_page_versions",
      title: "List a wiki page's versions",
      description: "Lists every version of one wiki page.",
      input: z.object({ wikiCategoryId, identifier }),
      path: (a) =>
        `/wiki/categories/${S(a.wikiCategoryId)}/pages/${S(a.identifier)}/versions`,
      key: "versions",
    },
  ]);
  registerPlans(server, deps, [
    {
      name: "ct_create_wiki_category",
      title: "Plan a new wiki category",
      description: "Creates a wiki category (fields per ct_get_operation).",
      input: z.object({ fields }),
      method: "POST",
      path: () => "/wiki/categories",
      body: bodyFields,
      summary: () => "Create a wiki category",
    },
    {
      name: "ct_update_wiki_category",
      title: "Plan a change to a wiki category",
      description: "Changes a wiki category (fields per ct_get_operation).",
      input: z.object({ wikiCategoryId, fields }),
      method: "PUT",
      path: (a) => `/wiki/categories/${S(a.wikiCategoryId)}`,
      guardPath: () => "/wiki/categories",
      body: bodyFields,
      summary: (a) => `Update wiki category ${S(a.wikiCategoryId)}`,
    },
    {
      name: "ct_delete_wiki_category",
      title: "Plan to delete a wiki category",
      description:
        "Deletes a wiki category; the preview shows the categories as they are now.",
      input: z.object({ wikiCategoryId }),
      method: "DELETE",
      path: (a) => `/wiki/categories/${S(a.wikiCategoryId)}`,
      guardPath: () => "/wiki/categories",
      summary: (a) => `Delete wiki category ${S(a.wikiCategoryId)}`,
    },
    {
      name: "ct_create_wiki_page",
      title: "Plan a new wiki page",
      description:
        "Creates a wiki page (the API requires a title; text is the page content).",
      input: z.object({ wikiCategoryId, fields }),
      method: "POST",
      path: (a) => `/wiki/categories/${S(a.wikiCategoryId)}/pages`,
      guardPath: (a) => `/wiki/categories/${S(a.wikiCategoryId)}/pages`,
      body: bodyFields,
      summary: (a) => `Create wiki page in category ${S(a.wikiCategoryId)}`,
    },
    {
      name: "ct_update_wiki_page",
      title: "Plan a change to a wiki page",
      description: "Changes a wiki page; a new text creates a new version.",
      input: z.object({ wikiCategoryId, identifier, fields }),
      method: "PATCH",
      path: (a) =>
        `/wiki/categories/${S(a.wikiCategoryId)}/pages/${S(a.identifier)}`,
      guardPath: (a) =>
        `/wiki/categories/${S(a.wikiCategoryId)}/pages/${S(a.identifier)}`,
      body: bodyFields,
      changed: true,
      summary: (a) => `Update wiki page ${S(a.identifier)}`,
    },
    {
      name: "ct_delete_wiki_page",
      title: "Plan to delete a wiki page",
      description: "Deletes a wiki page; the preview shows it as it is now.",
      input: z.object({ wikiCategoryId, identifier }),
      method: "DELETE",
      path: (a) =>
        `/wiki/categories/${S(a.wikiCategoryId)}/pages/${S(a.identifier)}`,
      guardPath: (a) =>
        `/wiki/categories/${S(a.wikiCategoryId)}/pages/${S(a.identifier)}`,
      summary: (a) => `Delete wiki page ${S(a.identifier)}`,
    },
  ]);
}
