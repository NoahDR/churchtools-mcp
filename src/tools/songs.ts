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

const songId = id.describe("The song's id");
const arrangementId = id.describe("The arrangement's id");

/** Songs and arrangements (Song tag). CCLI is not part of the REST spec and is not offered. */
export function registerSongTools(server: McpServer, deps: ToolDeps): void {
  registerReads(server, deps, [
    {
      name: "ct_search_songs",
      title: "Search ChurchTools songs",
      description: "Lists songs, optionally filtered by text or category ids.",
      input: z.object({
        query: z.string().optional().describe("Part of a song title"),
        song_category_ids: z
          .array(id)
          .optional()
          .describe("Only these song categories"),
        page: id.optional(),
        limit: id.max(500).optional(),
      }),
      path: () => "/songs",
      query: (a) => ({
        query: a.query as string,
        "song_category_ids[]": a.song_category_ids as number[],
        page: a.page as number,
        limit: a.limit as number,
      }),
      key: "songs",
    },
    {
      name: "ct_get_song",
      title: "Get a ChurchTools song",
      description: "Shows one song with its arrangements.",
      input: z.object({ songId }),
      path: (a) => `/songs/${S(a.songId)}`,
      key: "song",
    },
    {
      name: "ct_list_song_arrangements",
      title: "List a song's arrangements",
      description: "Lists the arrangements of one song.",
      input: z.object({ songId }),
      path: (a) => `/songs/${S(a.songId)}/arrangements`,
      key: "arrangements",
    },
    {
      name: "ct_get_song_arrangement",
      title: "Get a song arrangement",
      description: "Shows one arrangement of one song.",
      input: z.object({ songId, arrangementId }),
      path: (a) => `/songs/${S(a.songId)}/arrangements/${S(a.arrangementId)}`,
      key: "arrangement",
    },
    {
      name: "ct_list_song_categories",
      title: "List song categories",
      description: "Lists every song category.",
      input: z.object({}),
      path: () => "/song/categories",
      key: "categories",
    },
    {
      name: "ct_list_song_sources",
      title: "List song sources",
      description: "Lists every song source.",
      input: z.object({}),
      path: () => "/song/sources",
      key: "sources",
    },
  ]);
  registerPlans(server, deps, [
    {
      name: "ct_create_song",
      title: "Plan a new song",
      description:
        "Creates a song (fields per ct_get_operation, e.g. name, categoryId).",
      input: z.object({ fields }),
      method: "POST",
      path: () => "/songs",
      body: bodyFields,
      summary: () => "Create a song",
    },
    {
      name: "ct_update_song",
      title: "Plan a change to a song",
      description: "Changes only the fields of a song whose value differs.",
      input: z.object({ songId, fields }),
      method: "PUT",
      path: (a) => `/songs/${S(a.songId)}`,
      guardPath: (a) => `/songs/${S(a.songId)}`,
      body: bodyFields,
      changed: true,
      summary: (a) => `Update song ${S(a.songId)}`,
    },
    {
      name: "ct_delete_song",
      title: "Plan to delete a song",
      description: "Deletes a song; the preview shows the song as it is now.",
      input: z.object({ songId }),
      method: "DELETE",
      path: (a) => `/songs/${S(a.songId)}`,
      guardPath: (a) => `/songs/${S(a.songId)}`,
      summary: (a) => `Delete song ${S(a.songId)}`,
    },
    {
      name: "ct_create_song_arrangement",
      title: "Plan a new song arrangement",
      description:
        "Creates an arrangement for a song (fields per ct_get_operation; name is required by the API).",
      input: z.object({ songId, fields }),
      method: "POST",
      path: (a) => `/songs/${S(a.songId)}/arrangements`,
      guardPath: (a) => `/songs/${S(a.songId)}`,
      body: bodyFields,
      summary: (a) => `Create arrangement for song ${S(a.songId)}`,
    },
    {
      name: "ct_update_song_arrangement",
      title: "Plan a change to a song arrangement",
      description:
        "Changes only the fields of an arrangement whose value differs.",
      input: z.object({ songId, arrangementId, fields }),
      method: "PUT",
      path: (a) => `/songs/${S(a.songId)}/arrangements/${S(a.arrangementId)}`,
      guardPath: (a) =>
        `/songs/${S(a.songId)}/arrangements/${S(a.arrangementId)}`,
      body: bodyFields,
      changed: true,
      summary: (a) =>
        `Update arrangement ${S(a.arrangementId)} of song ${S(a.songId)}`,
    },
    {
      name: "ct_delete_song_arrangement",
      title: "Plan to delete a song arrangement",
      description: "Deletes an arrangement; the preview shows it as it is now.",
      input: z.object({ songId, arrangementId }),
      method: "DELETE",
      path: (a) => `/songs/${S(a.songId)}/arrangements/${S(a.arrangementId)}`,
      guardPath: (a) =>
        `/songs/${S(a.songId)}/arrangements/${S(a.arrangementId)}`,
      summary: (a) =>
        `Delete arrangement ${S(a.arrangementId)} of song ${S(a.songId)}`,
    },
    {
      name: "ct_set_default_arrangement",
      title: "Plan to make an arrangement the default",
      description: "Makes one arrangement the song's default arrangement.",
      input: z.object({ songId, arrangementId }),
      method: "PATCH",
      path: (a) =>
        `/songs/${S(a.songId)}/arrangements/${S(a.arrangementId)}/default`,
      guardPath: (a) =>
        `/songs/${S(a.songId)}/arrangements/${S(a.arrangementId)}`,
      summary: (a) =>
        `Make arrangement ${S(a.arrangementId)} the default of song ${S(a.songId)}`,
    },
  ]);
}
