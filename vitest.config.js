import { defineConfig } from "vitest/config";

/** `npm test` runs the unit project only; the live project runs through `npm run test:live`. */
export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["test/*.test.ts"] } },
      {
        test: {
          name: "live",
          include: ["test/live/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
