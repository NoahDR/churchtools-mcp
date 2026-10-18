import { readFileSync, readdirSync } from "node:fs";
import { matchesGlob } from "node:path";
import { expect, test } from "vitest";

/** The include globs of the unit project, read from the config text. */
const unitInclude = /name: "unit", include: \[([^\]]*)\]/
  .exec(readFileSync("vitest.config.js", "utf8"))?.[1]
  ?.match(/"[^"]+"/g)
  ?.map((glob) => glob.slice(1, -1));
const liveFiles = readdirSync("test/live").map((file) => `test/live/${file}`);

test("npm test runs the unit project only", () => {
  const { scripts } = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };

  expect(scripts.test).toBe("vitest run --project unit");
});

test("the unit project includes no file under test/live", () => {
  const included = liveFiles.filter((file) =>
    unitInclude?.some((glob) => matchesGlob(file, glob)),
  );

  expect(unitInclude?.length).toBeGreaterThan(0);
  expect(liveFiles.length).toBeGreaterThan(0);
  expect(included).toEqual([]);
});
