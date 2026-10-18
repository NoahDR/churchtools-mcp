import { z } from "zod";
import { parse } from "../ct/client.js";

export const id = z.number().int().positive();
export const page = id.describe("The page, from 1");
/** ChurchTools caps a page per endpoint: /persons at 500, /groups and group members at 200. */
export const limit = (noun: string, max = 500) =>
  id.max(max).optional().describe(`${noun} per page, 1-${max} (default 10)`);
export const read = { readOnlyHint: true, openWorldHint: true };
export const plan = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};

/** A malformed `meta` is dropped, so the list itself still arrives. */
const listMeta = z
  .object({
    pagination: z
      .object({
        current: z.number(),
        lastPage: z.number(),
        limit: z.number().optional(),
        total: z.number().optional(),
      })
      .optional(),
  })
  .optional()
  .catch(undefined);

/** The `data` items of a list answer as `item` reads them, plus its pagination when the answer has one. */
export function parseList<T>(
  item: z.ZodType<T>,
  answer: unknown,
  path: string,
) {
  const list = z.object({ data: z.array(item), meta: listMeta });
  const { data, meta } = parse(list, answer, path);
  return { data, ...(meta?.pagination && { pagination: meta.pagination }) };
}

/** `force` skips ChurchTools' duplicate check (a person query flag, a group body field); it is never sent. */
export function withoutForce(fields: Record<string, unknown> = {}) {
  return Object.fromEntries(
    Object.entries(fields).filter(([key]) => key !== "force"),
  );
}
