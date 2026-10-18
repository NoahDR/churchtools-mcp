import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type CtClient, SessionExpiredError, errorText } from "./ct/client.js";
import type { Session } from "./ct/session.js";

const specPath = "/system/runtime/swagger/openapi.json";
const maxSpecBytes = 100 * 1024 * 1024;
const maxSchemaDepth = 4;
const maxOperationChars = 20_000;
export const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const operationSchema = z.object({
  method: z.enum(methods),
  path: z.string(),
  summary: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()),
  parameters: z.array(z.unknown()),
  requestBody: z.unknown().optional(),
});
export type Operation = z.infer<typeof operationSchema>;
const indexSchema = z.array(operationSchema);

/** Lenient: the demo spec has `summary: null`; a malformed part is dropped. */
const specOperationSchema = z.object({
  summary: z.string().optional().catch(undefined),
  description: z.string().optional().catch(undefined),
  tags: z.array(z.string()).optional().catch(undefined),
  parameters: z.array(z.unknown()).optional().catch(undefined),
  requestBody: z.unknown().optional(),
});
const specSchema = z.object({ paths: z.record(z.string(), z.unknown()) });
const pathItemSchema = z.record(z.string(), z.unknown());
/** /info answers without the usual `data` envelope. */
const infoSchema = z.object({ version: z.string() });

const notFound =
  "Find the operation with ct_search_api; paths are relative to /api, e.g. /persons/12. Path values may contain only letters, digits and . _ ~ -";

function isContainer(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function mapChildren(
  value: object,
  map: (key: string, child: unknown) => unknown,
): unknown {
  if (Array.isArray(value)) return value.map((v, i) => map(String(i), v));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, map(k, v)]),
  );
}

/** An operation's own parameters replace the path's parameters of the same name and place. */
function mergeParameters(shared: unknown[], own: unknown[]): unknown[] {
  const key = (p: unknown) =>
    isContainer(p) && "name" in p && "in" in p
      ? `${String(p.in)} ${String(p.name)}`
      : "";
  const ownKeys = new Set(own.map(key));
  return [...shared.filter((p) => !ownKeys.has(key(p))), ...own];
}

function toIndex(spec: unknown): Operation[] {
  if (typeof spec === "string") {
    throw new Error("The OpenAPI spec of ChurchTools is not valid JSON");
  }
  const parsed = specSchema.safeParse(spec);
  if (!parsed.success) {
    throw new Error("The OpenAPI spec of ChurchTools has no valid paths");
  }
  return Object.entries(parsed.data.paths).flatMap(([path, value]) => {
    // An extension such as "x-generated": true is no path item: skip it, keep the rest.
    const parsedItem = pathItemSchema.safeParse(value);
    if (!parsedItem.success) return [];
    const item = parsedItem.data;
    const shared = z.array(z.unknown()).catch([]).parse(item.parameters);
    return methods.flatMap((method) => {
      const found = specOperationSchema.safeParse(item[method.toLowerCase()]);
      if (!found.success) return [];
      const { summary, description, tags, parameters, requestBody } =
        found.data;
      return [
        {
          method,
          path,
          summary: summary ?? "",
          description,
          tags: tags ?? [],
          parameters: mergeParameters(shared, parameters ?? []),
          requestBody,
        },
      ];
    });
  });
}

async function fetchSpec(client: CtClient): Promise<unknown> {
  try {
    return await client.getFile(specPath, maxSpecBytes);
  } catch (error) {
    if (error instanceof SessionExpiredError) throw error;
    throw new Error(
      `Could not load the OpenAPI spec of ChurchTools: ${errorText(error)}`,
    );
  }
}

/** One file per instance and version; encoded, so no part of the name can leave the directory. */
function cacheName(baseUrl: string, version: string): string {
  const instance = baseUrl.replace(/^https:\/\//, "");
  return `${encodeURIComponent(instance)}-${encodeURIComponent(version)}.json`;
}

/** A missing, corrupt or partial file is a miss. */
async function readCache(file: string): Promise<Operation[] | undefined> {
  try {
    return indexSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return undefined;
  }
}

/** Written aside and renamed, so a reader never sees a part; a failure only costs the next load. */
async function writeCache(file: string, index: Operation[]): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temp, JSON.stringify(index));
    await rename(temp, file);
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

/** The operations of the instance's OpenAPI spec: loaded once per server, cached on disk per instance and version. */
export function createSpec(session: Pick<Session, "use">, cacheDir?: string) {
  let loading: Promise<Operation[]> | undefined;

  async function load(client: CtClient): Promise<Operation[]> {
    const info = infoSchema.safeParse(await client.request("GET", "/info"));
    if (!info.success) throw new Error("Unexpected answer from /info");
    const name = cacheName(client.baseUrl, info.data.version);
    const file = cacheDir === undefined ? undefined : join(cacheDir, name);
    const cached = file && (await readCache(file));
    if (cached) return cached;
    const index = toIndex(await fetchSpec(client));
    if (file) await writeCache(file, index);
    return index;
  }

  return {
    /** A failed load is not kept: the next call loads again. */
    operations(): Promise<Operation[]> {
      loading ??= session.use(load).catch((error: unknown) => {
        loading = undefined;
        throw error;
      });
      return loading;
    },
  };
}

export type Spec = ReturnType<typeof createSpec>;

/** Operations whose method, path, summary or tags hold the most keywords first. */
export function searchOperations(
  operations: Operation[],
  query: string,
  limit: number,
) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = operations
    .map((operation) => {
      const { method, path, summary, tags } = operation;
      const text = [method, path, summary, ...tags].join(" ").toLowerCase();
      return { operation, score: words.filter((w) => text.includes(w)).length };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);
  return {
    total: hits.length,
    operations: hits
      .slice(0, limit)
      .map(({ operation: { method, path, summary, tags } }) => ({
        method,
        path,
        summary,
        tags,
      })),
  };
}

const isParameter = (part: string) => /^\{[^}]+\}$/.test(part);
/** No dot segment, no slash, no percent sign: a value cannot climb out of its template. */
const isPathValue = (segment: string) =>
  /^[\w.~-]+$/.test(segment) && !/^\.+$/.test(segment);

/** The templates `path` fills with the most literal segments: a literal beats a `{param}` in its place. */
function templatesOf(templates: string[], path: string): string[] {
  const segments = path.split("/");
  const fits = (template: string) => {
    const parts = template.split("/");
    return (
      parts.length === segments.length &&
      parts.every((part, i) => {
        const segment = segments[i] ?? "";
        return isParameter(part) ? isPathValue(segment) : part === segment;
      })
    );
  };
  const specificity = (template: string) =>
    template
      .split("/")
      .map((part) => (isParameter(part) ? "0" : "1"))
      .join("");
  const fitting = templates.filter(fits);
  const best = fitting.map(specificity).sort().at(-1);
  return fitting.filter((template) => specificity(template) === best);
}

/** The operation of `method` on one of `templates`; none is an error naming the methods they have. */
function pick(
  operations: Operation[],
  method: Operation["method"],
  templates: string[],
): Operation {
  const onTemplates = operations.filter((o) => templates.includes(o.path));
  const operation = onTemplates.find((o) => o.method === method);
  if (operation) return operation;
  const allowed = [...new Set(onTemplates.map((o) => o.method))].sort();
  throw new Error(
    `${method} is not defined for ${templates.join(" or ")}; it has ${allowed.join(", ")}. ${notFound}`,
  );
}

/** The operation a concrete path calls; a query, a fragment or an absolute URL is an error. */
export function resolveOperation(
  operations: Operation[],
  method: Operation["method"],
  path: string,
): Operation {
  if (!path.startsWith("/")) {
    throw new Error(
      "The path needs a leading / and is relative to /api, e.g. /persons/12",
    );
  }
  if (/[?#]/.test(path)) {
    throw new Error("Put query parameters into `query`, not into the path");
  }
  const templates = templatesOf(
    [...new Set(operations.map((o) => o.path))],
    path,
  );
  if (templates.length === 0) {
    throw new Error(`No operation matches ${path}. ${notFound}`);
  }
  return pick(operations, method, templates);
}

/** The operation of `method` on a template as ct_search_api lists it. */
export function operationAt(
  operations: Operation[],
  method: Operation["method"],
  template: string,
): Operation {
  return pick(operations, method, [template]);
}

/** Containers below `maxSchemaDepth` inside a schema become "…". */
function prune(value: unknown, depth = 0): unknown {
  if (!isContainer(value)) return value;
  if (depth > maxSchemaDepth) return "…";
  return mapChildren(value, (_, child) => prune(child, depth + 1));
}

function pruneSchemas(value: unknown): unknown {
  if (!isContainer(value)) return value;
  return mapChildren(value, (key, child) =>
    key === "schema" ? prune(child) : pruneSchemas(child),
  );
}

/** Parameters and request body with pruned schemas; above 20 000 characters, the JSON text cut there. */
export function describeOperation(operation: Operation) {
  const pruned = pruneSchemas(operation);
  const text = JSON.stringify(pruned);
  if (text.length <= maxOperationChars) return pruned;
  return {
    truncated: true,
    note: `The operation's JSON text is longer than ${maxOperationChars} characters and is cut there.`,
    text: text.slice(0, maxOperationChars).toWellFormed(),
  };
}
