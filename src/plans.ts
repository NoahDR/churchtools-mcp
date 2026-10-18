import { randomUUID } from "node:crypto";
import {
  CtError,
  type FieldError,
  errorText,
  type Method,
  type Query,
} from "./ct/client.js";
import { type Session, loginRequired } from "./ct/session.js";

/** One write of a plan; `before` is the record it changes (absent for a create). */
export interface Change {
  method: Exclude<Method, "GET">;
  path: string;
  query?: Query;
  body?: unknown;
  before?: unknown;
}

/** Re-read before writing: `data` must still be the GET `data`, `absent` must still be a 404. */
export type Guard =
  { path: string; data: unknown } | { path: string; absent: true };

export interface PlanInput {
  summary: string;
  changes: Change[];
  guards: Guard[];
}

/** A failed plan; `details` keeps the server's field errors and args of a failed write. */
export class PlanError extends Error {
  constructor(
    message: string,
    readonly details: { errors?: FieldError[]; args?: unknown } = {},
  ) {
    super(message);
    this.name = "PlanError";
  }
}

interface Plan extends PlanInput {
  expiresAt: number;
}

const lifetimeMs = 10 * 60 * 1000;
const next =
  "Show this preview to the user. Only after their yes, call ct_execute_plan with the token; it is valid once, for 10 minutes.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON with object keys sorted at every depth; arrays keep their order; undefined stays undefined. */
function canonical(value: unknown): string | undefined {
  const sorted = (_key: string, v: unknown) =>
    isRecord(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v;
  return JSON.stringify(value, sorted);
}

/** The body as the request sends it: JSON drops undefined and keeps null. */
function asSent(body: unknown): unknown {
  const text = JSON.stringify(body);
  return text === undefined ? undefined : JSON.parse(text);
}

function changedFields(old: unknown, now: unknown): string[] {
  if (!isRecord(old) || !isRecord(now)) return ["(whole record)"];
  const keys = new Set([...Object.keys(old), ...Object.keys(now)]);
  return [...keys]
    .filter((k) => canonical(old[k]) !== canonical(now[k]))
    .sort();
}

function label({ method, path }: Change): string {
  return `${method} ${path}`;
}

/** Create: every field. Update: before → after of each changed field. Delete: the whole record. */
function previewOf({ method, path, query, body, before }: Change) {
  const request = { method, path, ...(query && { query }) };
  if (method === "DELETE") {
    return {
      ...request,
      record: before,
      ...(body !== undefined && { body: asSent(body) }),
    };
  }
  const sent = asSent(body);
  if (!isRecord(sent)) return { ...request, before, after: sent };
  const old = isRecord(before) ? before : undefined;
  const fields = Object.entries(old ? changedOnly(old, sent) : sent).map(
    ([k, after]) => [
      k,
      old
        ? { before: Object.hasOwn(old, k) ? old[k] : "(absent)", after }
        : { after },
    ],
  );
  return { ...request, fields: Object.fromEntries(fields) as object };
}

/** The fields, as sent, whose value differs from the same field of `before`. */
export function changedOnly(
  before: unknown,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const sent = asSent(fields) as Record<string, unknown>;
  const old = isRecord(before) ? before : {};
  return Object.fromEntries(
    Object.entries(sent).filter(([k, v]) => canonical(old[k]) !== canonical(v)),
  );
}

/** The record at `path` and a guard that holds it; an answer without a `data` envelope cannot guard a write. */
export async function readGuarded(
  session: Pick<Session, "use">,
  path: string,
): Promise<{ guard: Guard; before: unknown }> {
  const answer = await session.use((client) => client.request("GET", path));
  if (!isRecord(answer) || !("data" in answer)) {
    throw new Error(
      `GET ${path} answered without a data envelope, so the write cannot be guarded`,
    );
  }
  return { guard: { path, data: answer.data }, before: answer.data };
}

/** Like readGuarded, but a 404 guards that the record stays absent; `before` is then undefined. */
export async function guardOf(
  session: Pick<Session, "use">,
  path: string,
): Promise<{ guard: Guard; before?: unknown }> {
  try {
    return await readGuarded(session, path);
  } catch (error) {
    if (error instanceof CtError && error.status === 404) {
      return { guard: { path, absent: true } };
    }
    throw error;
  }
}

/** Why a guard no longer holds, or undefined when it does. */
async function guardProblem(
  session: Pick<Session, "use">,
  guard: Guard,
): Promise<string | undefined> {
  let answer: unknown;
  try {
    answer = await session.use((client) => client.request("GET", guard.path));
  } catch (error) {
    if (error instanceof CtError && error.status === 404) {
      return "absent" in guard ? undefined : "no longer exists";
    }
    return `could not be re-read: ${errorText(error)}`;
  }
  if ("absent" in guard) return "exists now; the plan expected it absent";
  if (!isRecord(answer) || !("data" in answer)) {
    return "was re-read without a data envelope";
  }
  if (canonical(answer.data) === canonical(guard.data)) return undefined;
  return `changed since the preview (fields: ${changedFields(guard.data, answer.data).join(", ")})`;
}

/** A 4xx answer or a refused login proves the write did not happen; a 5xx or a lost connection does not. */
function surelyNotApplied(error: unknown): boolean {
  if (error instanceof CtError) return error.status < 500;
  return error instanceof Error && error.message === loginRequired;
}

function failureReport(changes: Change[], index: number, error: unknown) {
  const failed = changes[index];
  const written = changes.slice(0, index).map(label).join(", ");
  const notRun = changes
    .slice(index + 1)
    .map(label)
    .join(", ");
  const message = [
    `Change ${index + 1} of ${changes.length} (${label(failed)}) failed: ${errorText(error)}`,
    ...(surelyNotApplied(error)
      ? []
      : ["It may still have been applied; check it in ChurchTools"]),
    `Written: ${written || "nothing"}`,
    `Not run: ${notRun || "nothing"}`,
  ].join(". ");
  const details =
    error instanceof CtError ? { errors: error.errors, args: error.args } : {};
  return new PlanError(message, details);
}

/** The plans of one server, in memory only: a token is valid once, for 10 minutes. */
export function createPlans(session: Pick<Session, "use">) {
  const plans = new Map<string, Plan>();

  function dropExpired(): void {
    for (const [token, plan] of plans) {
      if (plan.expiresAt <= Date.now()) plans.delete(token);
    }
  }

  /** Synchronous, so two parallel calls with one token cannot both get the plan. */
  function take(token: string): Plan {
    const plan = plans.get(token);
    plans.delete(token);
    if (!plan || plan.expiresAt <= Date.now()) {
      throw new Error(
        "The plan token is unknown, expired or already used. Create a new plan.",
      );
    }
    return plan;
  }

  async function checkGuards(guards: Guard[]): Promise<void> {
    for (const guard of guards) {
      const problem = await guardProblem(session, guard);
      if (problem) {
        throw new Error(
          `Nothing was written: ${guard.path} ${problem}. Create a new plan.`,
        );
      }
    }
  }

  async function write(changes: Change[]) {
    const results = [];
    for (const [index, change] of changes.entries()) {
      const { method, path, query, body } = change;
      try {
        const result = await session.use((client) =>
          client.request(method, path, { query, body }),
        );
        results.push({ request: label(change), result });
      } catch (error) {
        throw failureReport(changes, index, error);
      }
    }
    return results;
  }

  return {
    /** Holds a copy of `input`: later changes to it touch neither the preview nor the writes. */
    createPlan(input: PlanInput) {
      const plan = {
        ...structuredClone(input),
        expiresAt: Date.now() + lifetimeMs,
      };
      const token = randomUUID();
      dropExpired();
      plans.set(token, plan);
      const preview = {
        summary: plan.summary,
        expiresAt: new Date(plan.expiresAt).toISOString(),
        changes: plan.changes.map(previewOf),
        next,
      };
      return { token, preview };
    },

    /** Re-reads every guard, then runs the changes in order and stops at the first failure. */
    async executePlan(token: string) {
      const plan = take(token);
      await checkGuards(plan.guards);
      return { executed: plan.summary, results: await write(plan.changes) };
    },

    /** The number of plans held in memory. */
    size: () => plans.size,
  };
}

export type Plans = ReturnType<typeof createPlans>;
