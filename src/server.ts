import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Query } from "./ct/client.js";
import { createSession } from "./ct/session.js";
import { createPlans, guardOf } from "./plans.js";
import { registerAbsenceTools } from "./tools/absences.js";
import { registerAgendaTools } from "./tools/agenda.js";
import { registerCalendarTools } from "./tools/calendars.js";
import { registerEventTools } from "./tools/events.js";
import { registerGroupTools } from "./tools/groups.js";
import { registerFactTools } from "./tools/facts.js";
import { registerMasterdataTools } from "./tools/masterdata.js";
import { registerMeetingFollowupTools } from "./tools/meetings-followups.js";
import { registerPersonTools } from "./tools/persons.js";
import { registerModernServiceTools } from "./tools/services-modern.js";
import { registerPostPermissionTools } from "./tools/posts-permissions.js";
import { registerPublicFileCalendarTools } from "./tools/public-files-calendar.js";
import { registerResourceTools } from "./tools/resources.js";
import { registerSongTools } from "./tools/songs.js";
import { registerTagNoteTools } from "./tools/tags-notes.js";
import { registerWikiTools } from "./tools/wiki.js";
import { toolResult } from "./tools/result.js";
import {
  createSpec,
  describeOperation,
  methods,
  operationAt,
  resolveOperation,
  searchOperations,
} from "./spec.js";

export interface Dependencies {
  env: NodeJS.ProcessEnv;
  fetch: typeof globalThis.fetch;
  /** Where the OpenAPI spec is cached; without it, the spec stays in memory only. */
  cacheDir?: string;
}

/** Login runs through ct_login only; these return or change the session's secrets. */
const notExposed =
  /^\/(login(\/.*)?|logout|csrftoken|persons\/\{[^}]+\}\/(logintoken|loginstring))$/;

const queryValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number()])),
]);
const method = z.enum(methods).describe("The HTTP method");

export function createServer({
  env,
  fetch,
  cacheDir,
}: Dependencies): McpServer {
  const server = new McpServer({ name: "churchtools-mcp", version: "0.1.0" });
  const session = createSession({ env, fetch });
  const plans = createPlans(session);
  const spec = createSpec(session, cacheDir);
  registerPersonTools(server, { session, plans });
  registerGroupTools(server, { session, plans });
  registerCalendarTools(server, { session, plans });
  registerEventTools(server, { session, plans });
  registerAgendaTools(server, { session, plans });
  registerSongTools(server, { session, plans });
  registerModernServiceTools(server, { session, plans });
  registerAbsenceTools(server, { session, plans });
  registerResourceTools(server, { session, plans });
  registerMasterdataTools(server, { session, plans });
  registerFactTools(server, { session, plans });
  registerMeetingFollowupTools(server, { session, plans });
  registerWikiTools(server, { session, plans });
  registerTagNoteTools(server, { session, plans });
  registerPublicFileCalendarTools(server, { session, plans });
  registerPostPermissionTools(server, { session, plans });

  /** GET runs at once; any other method becomes a plan. PUT, PATCH and DELETE are guarded by a GET on the same path when the spec has one; a POST creates, so it has no guard. */
  async function apiRequest(request: {
    method: (typeof methods)[number];
    path: string;
    query?: Query;
    body?: unknown;
  }) {
    const { method, path, query, body } = request;
    if (method === "GET" && body !== undefined) {
      throw new Error("A GET takes no body; put its parameters into `query`");
    }
    const operations = await spec.operations();
    const { path: template } = resolveOperation(operations, method, path);
    if (notExposed.test(template.toLowerCase().replace(/\/+$/, ""))) {
      throw new Error(
        `${template} is not exposed: it logs in or out or returns a secret. Use ct_login to log in.`,
      );
    }
    if (method === "GET") {
      return session.use((client) => client.request("GET", path, { query }));
    }
    const guarded =
      method !== "POST" &&
      operations.some((o) => o.path === template && o.method === "GET");
    const { guard, before } = guarded ? await guardOf(session, path) : {};
    return plans.createPlan({
      summary: `${method} ${path}`,
      changes: [{ method, path, query, body, before }],
      guards: guard ? [guard] : [],
    });
  }

  server.registerTool(
    "ct_login",
    {
      title: "Log in to ChurchTools",
      description:
        "Logs in with the configured user and the current 2FA code from the user's authenticator app. Ask the user for the code; never guess it. A new call replaces the current session.",
      inputSchema: z.object({
        code: z
          .string()
          .regex(/^\d{6}$/, "must be the 6-digit 2FA code")
          .describe("The current 6-digit 2FA code"),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    ({ code }) => toolResult(() => session.login(code)),
  );

  server.registerTool(
    "ct_status",
    {
      title: "ChurchTools status",
      description:
        "Shows whether the configuration is valid, the login state, the logged-in user and the ChurchTools version, build and site name.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => toolResult(() => session.status()),
  );

  server.registerTool(
    "ct_execute_plan",
    {
      title: "Execute a ChurchTools plan",
      description:
        "Runs the writes of a plan that a ChurchTools write tool returned. Call it only after the user saw the preview and said yes. A token is valid once, for 10 minutes. Every guarded record is re-read first; if one changed, nothing is written.",
      inputSchema: z.object({
        token: z.uuid().describe("The token of the plan to execute"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ token }) => toolResult(() => plans.executePlan(token)),
  );

  server.registerTool(
    "ct_search_api",
    {
      title: "Search the ChurchTools API",
      description:
        "Finds operations of this instance's ChurchTools REST API by keywords over method, path, summary and tags. Use it for anything no other tool covers, then ct_get_operation for the parameters and ct_api_request to call it.",
      inputSchema: z.object({
        query: z
          .string()
          .regex(/\S/, "must not be blank")
          .describe("Keywords, e.g. 'group members'"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("At most this many operations (1-100)"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ query, limit }) =>
      toolResult(async () =>
        searchOperations(await spec.operations(), query, limit),
      ),
  );

  server.registerTool(
    "ct_get_operation",
    {
      title: "Describe a ChurchTools API operation",
      description:
        "Shows the parameters and the request body schema of one ChurchTools API operation. Schemas are cut below depth 4, long answers at 20 000 characters.",
      inputSchema: z.object({
        method,
        path: z
          .string()
          .describe(
            "The path as ct_search_api lists it, e.g. /persons/{personId}, or a concrete path such as /persons/12",
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ method, path }) =>
      toolResult(async () => {
        const operations = await spec.operations();
        const isTemplate = operations.some((o) => o.path === path);
        const operation = isTemplate
          ? operationAt(operations, method, path)
          : resolveOperation(operations, method, path);
        return describeOperation(operation);
      }),
  );

  server.registerTool(
    "ct_api_request",
    {
      title: "Call the ChurchTools API",
      description:
        "Calls any operation of the ChurchTools REST API. GET runs at once. POST, PUT, PATCH and DELETE write nothing: they return a plan with a preview and a token for ct_execute_plan. The path must match an operation of the spec, with every value filled in.",
      inputSchema: z.object({
        method,
        path: z
          .string()
          .describe(
            "Concrete path relative to /api without a query string, e.g. /persons/12",
          ),
        query: z
          .record(z.string(), queryValue)
          .optional()
          .describe("Query parameters; an array repeats the key"),
        body: z.unknown().optional().describe("The JSON body of a write"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    (request) => toolResult(() => apiRequest(request)),
  );

  return server;
}
