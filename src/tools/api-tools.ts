import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Query } from "../ct/client.js";
import type { Session } from "../ct/session.js";
import { type Plans, changedOnly, readGuarded } from "../plans.js";
import { id, plan, read, withoutForce } from "./common.js";
import { toolResult } from "./result.js";

/**
 * Shared building blocks for the curated coverage tools.
 * Every path used here was verified against the instance OpenAPI spec
 * (525 paths / 809 operations, demo spec 2026-10). Finance paths are
 * refused outright: no finance tool is registered anywhere in this server.
 */

export type Args = Record<string, unknown>;
/** A path/summary interpolation of an argument, as text. */
export const S = (value: unknown): string => String(value);
export { id };

/** A value that fills one `{param}` of a path: no slash, no dot segment, no percent sign. */
export const slug = z
  .string()
  .regex(/^[\w~-]+$/, "may contain only letters, digits and _ ~ -")
  .refine((v) => !/^\.+$/.test(v), "must not be a dot segment");
/** A ChurchTools domain type such as `person`, `group` or `event`. */
export const domainType = z
  .string()
  .regex(/^[a-z]+$/, "must be a lowercase domain type, e.g. person");
export const fields = z
  .record(z.string(), z.unknown())
  .refine((f) => Object.keys(f).length > 0, "must name at least one field")
  .describe("The fields to set, as the API names them (see ct_get_operation)");
export const optionalFields = z
  .record(z.string(), z.unknown())
  .optional()
  .describe("Further fields, as the API names them (see ct_get_operation)");
export const pageQuery = z.object({
  page: id.optional().describe("The page, from 1"),
  limit: id
    .max(500)
    .optional()
    .describe("Records per page, 1-500 (ChurchTools decides the default)"),
});

export interface ToolDeps {
  session: Pick<Session, "use">;
  plans: Plans;
}

function assertAllowed(path: string): void {
  if (/^\/finance(\/|$)/i.test(path)) {
    throw new Error("Finance endpoints are not exposed by this server");
  }
  if (/\/(logintoken|loginstring|password|twofactor)(\/|$)/i.test(path)) {
    throw new Error("Login, password and 2FA endpoints are not exposed");
  }
}

/** The `data` of an answer (plus pagination), or the answer itself when it has no envelope. */
export function unwrap(answer: unknown, key?: string): unknown {
  if (typeof answer === "object" && answer !== null && "data" in answer) {
    const record = answer as { data: unknown; meta?: unknown };
    const meta = record.meta as
      { pagination?: Record<string, unknown> } | undefined;
    const pagination = meta?.pagination && { pagination: meta.pagination };
    return key
      ? { [key]: record.data, ...pagination }
      : { data: record.data, ...pagination };
  }
  return answer;
}

export interface ReadDef {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  path: (args: Args) => string;
  query?: (args: Args) => Query | undefined;
  key?: string;
  /** A non-mutating POST the API uses as a pure computation (booking conflicts). */
  viaPost?: (args: Args) => unknown;
}

/** Registers reads: they run at once and never write. */
export function registerReads(
  server: McpServer,
  { session }: ToolDeps,
  defs: ReadDef[],
): void {
  for (const def of defs) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input,
        annotations: read,
      },
      (args: Args) =>
        toolResult(async () => {
          const path = def.path(args);
          assertAllowed(path);
          const answer = await session.use((client) =>
            def.viaPost
              ? client.request("POST", path, { body: def.viaPost(args) })
              : client.request("GET", path, { query: def.query?.(args) }),
          );
          return unwrap(answer, def.key);
        }),
    );
  }
}

export interface PlanDef {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: (args: Args) => string;
  /** GET path that guards the write; without it the write is a create/action on a guarded parent. */
  guardPath?: (args: Args) => string | undefined;
  body?: (args: Args) => unknown;
  query?: (args: Args) => Query | undefined;
  summary: (args: Args) => string;
  /** Drop body fields whose value already matches the guarded record. */
  changed?: boolean;
  /** Extra preview data (e.g. booking conflicts), computed before the plan is stored. */
  extra?: (
    args: Args,
    post: (path: string, body: unknown) => Promise<unknown>,
  ) => Promise<Record<string, unknown>>;
}

/** Registers writes: they only build a plan; `ct_execute_plan` writes after the user's yes. */
export function registerPlans(
  server: McpServer,
  { session, plans }: ToolDeps,
  defs: PlanDef[],
): void {
  for (const def of defs) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: `Writes nothing: returns a plan. ${def.description}`,
        inputSchema: def.input,
        annotations: plan,
      },
      (args: Args) =>
        toolResult(async () => {
          const path = def.path(args);
          assertAllowed(path);
          const guardPath = def.guardPath?.(args);
          let guard;
          let before: unknown;
          if (guardPath) {
            assertAllowed(guardPath);
            ({ guard, before } = await readGuarded(session, guardPath));
          } else {
            await session.use(() => Promise.resolve());
          }
          let body = def.body?.(args);
          if (body && typeof body === "object" && !Array.isArray(body)) {
            body = withoutForce(body as Record<string, unknown>);
          }
          if (def.changed && before !== undefined) {
            body = changedOnly(before, body as Record<string, unknown>);
            if (Object.keys(body as object).length === 0) {
              throw new Error("No change: the record already has these values");
            }
          }
          const extra = def.extra
            ? await def.extra(args, (p, b) =>
                session.use((client) => client.request("POST", p, { body: b })),
              )
            : undefined;
          const { token, preview } = plans.createPlan({
            summary: def.summary(args),
            changes: [
              {
                method: def.method,
                path,
                query: def.query?.(args),
                body,
                before,
              },
            ],
            guards: guard ? [guard] : [],
          });
          return extra
            ? { token, preview: { ...preview, ...extra } }
            : { token, preview };
        }),
    );
  }
}

/** Convenience: a `fields`-only body. */
export const bodyFields = (args: Args) => args.fields;
