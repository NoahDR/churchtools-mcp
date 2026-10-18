import { expect, test } from "vitest";
import { createSession, loginRequired } from "../src/ct/session.js";
import { type Change, type PlanInput, createPlans } from "../src/plans.js";
import {
  code,
  cookieValue,
  csrfToken,
  env,
  fakeFetch,
  json,
  loginAnswers,
} from "./fake-fetch.js";

const api = "/churchtools/api";
const person = { id: 1, firstName: "Ben", email: "ben@example.org" };

/** A ready session whose later requests get `answers`; `calls` holds only those later requests. */
async function loggedIn(...answers: (Response | Error)[]) {
  const { fetch, calls } = fakeFetch(...loginAnswers(), ...answers);
  const session = createSession({ env, fetch });
  await session.login(code);
  calls.splice(0);
  const requests = () => calls.map((c) => `${c.method} ${c.path}`);
  return { plans: createPlans(session), session, calls, requests };
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a failure");
}

const patch: Change = {
  method: "PATCH",
  path: "/persons/1",
  body: { email: "ben@new.org" },
  before: person,
};

function guarded(data: unknown, path = "/persons/1"): PlanInput {
  return {
    summary: "Change Ben's e-mail",
    changes: [patch],
    guards: [{ path, data }],
  };
}

function previewOf(change: Change) {
  return createPlans({
    use: () => Promise.reject(new Error("no request expected")),
  }).createPlan({ summary: "s", changes: [change], guards: [] }).preview
    .changes[0];
}

// Guard data shapes

test("a guard holds for nulls, nested arrays of objects and an undefined key in any key order", async () => {
  const stored = {
    a: null,
    b: [{ x: 1, y: [null, { z: "2026-10-06" }] }],
    c: undefined,
  };
  const { plans, requests } = await loggedIn(
    json({ data: { b: [{ y: [null, { z: "2026-10-06" }], x: 1 }], a: null } }),
    json({ data: {} }),
  );
  const { token } = plans.createPlan(guarded(stored));

  await plans.executePlan(token);

  expect(requests()).toEqual([
    `GET ${api}/persons/1`,
    `PATCH ${api}/persons/1`,
  ]);
});

test("a number that now reads as a string is a change and names the field", async () => {
  const { plans, requests } = await loggedIn(
    json({ data: { ...person, statusId: "1" } }),
  );
  const { token } = plans.createPlan(guarded({ ...person, statusId: 1 }));

  const message = await messageOf(plans.executePlan(token));

  expect(message).toContain("fields: statusId)");
  expect(requests()).toEqual([`GET ${api}/persons/1`]);
});

test("a date string in another format is a change: the guard compares text, not instants", async () => {
  const { plans, requests } = await loggedIn(
    json({ data: { ...person, birthday: "2026-01-02T00:00:00.000Z" } }),
  );
  const { token } = plans.createPlan(
    guarded({ ...person, birthday: "2026-01-02T00:00:00Z" }),
  );

  const message = await messageOf(plans.executePlan(token));

  expect(message).toContain("fields: birthday)");
  expect(requests()).toEqual([`GET ${api}/persons/1`]);
});

test("a field that turned from null into missing is named in the abort message", async () => {
  const { plans, requests } = await loggedIn(json({ data: person }));
  const { token } = plans.createPlan(guarded({ ...person, nickname: null }));

  const message = await messageOf(plans.executePlan(token));

  expect(requests()).toEqual([`GET ${api}/persons/1`]);
  expect(message).toContain("fields: nickname)");
});

test("a guard on a list holds when the list is unchanged, whatever the meta says", async () => {
  const list = [{ personId: 1 }, { personId: 2 }];
  const { plans, requests } = await loggedIn(
    json({ data: list, meta: { pagination: { current: 1, lastPage: 1 } } }),
    json({ data: {} }),
  );
  const { token } = plans.createPlan(guarded(list, "/groups/5/members"));

  await plans.executePlan(token);

  expect(requests()).toEqual([
    `GET ${api}/groups/5/members`,
    `PATCH ${api}/persons/1`,
  ]);
});

test("a guard on a list aborts when an entry was added", async () => {
  const list = [{ personId: 1 }];
  const { plans, requests } = await loggedIn(
    json({ data: [...list, { personId: 2 }] }),
  );
  const { token } = plans.createPlan(guarded(list, "/groups/5/members"));

  const message = await messageOf(plans.executePlan(token));

  expect(message).toContain("Nothing was written");
  expect(message).toContain("(whole record)");
  expect(requests()).toEqual([`GET ${api}/groups/5/members`]);
});

test("a guard whose re-read is a 200 HTML page aborts with zero writes", async () => {
  const { plans, requests } = await loggedIn(
    new Response("<html>Maintenance</html>", { status: 200 }),
  );
  const { token } = plans.createPlan(guarded(person));

  const message = await messageOf(plans.executePlan(token));

  expect(message).toContain("Nothing was written");
  expect(requests()).toEqual([`GET ${api}/persons/1`]);
});

test("a guard taken from an answer without a data envelope still catches a changed record", async () => {
  // A GET that answers a bare record has no `data`, so the stored guard data is undefined.
  const { plans, requests } = await loggedIn(
    json({ ...person, email: "changed@example.org" }),
  );
  const { token } = plans.createPlan(guarded(undefined));

  await Promise.allSettled([plans.executePlan(token)]);

  expect(requests()).toEqual([`GET ${api}/persons/1`]);
});

test("a guard field named __proto__ in JSON data is compared like any other field", async () => {
  const stored: unknown = JSON.parse('{"id":1,"__proto__":{"role":"user"}}');
  const { plans, requests } = await loggedIn(
    new Response('{"data":{"id":1,"__proto__":{"role":"admin"}}}'),
  );
  const { token } = plans.createPlan(guarded(stored));

  const message = await messageOf(plans.executePlan(token));

  expect(message).toContain("Nothing was written");
  expect(requests()).toEqual([`GET ${api}/persons/1`]);
});

test("a very large record with one changed field aborts and names only that field", async () => {
  const big: Record<string, unknown> = { list: [] as number[] };
  for (let i = 0; i < 5000; i++) big[`field${i}`] = `value ${i}`;
  (big.list as number[]).push(...Array.from({ length: 20_000 }, (_, i) => i));
  const { plans, requests } = await loggedIn(
    json({ data: { ...big, field4321: "changed" } }),
  );
  const { token } = plans.createPlan(guarded(big));

  const message = await messageOf(plans.executePlan(token));

  expect(message).toContain("fields: field4321)");
  expect(requests()).toEqual([`GET ${api}/persons/1`]);
});

// Absent guards and guard errors

test.each([
  ["403", 403],
  ["500", 500],
])(
  "an absent guard that answers %s is not taken as absent and writes nothing",
  async (_, status) => {
    const { plans, requests } = await loggedIn(
      json({ message: "No" }, { status }),
    );
    const { token } = plans.createPlan({
      summary: "Add Ben to group 5",
      changes: [{ method: "PUT", path: "/groups/5/members/1", body: {} }],
      guards: [{ path: "/groups/5/members/1", absent: true }],
    });

    const message = await messageOf(plans.executePlan(token));

    expect(message).toContain("could not be re-read");
    expect(requests()).toEqual([`GET ${api}/groups/5/members/1`]);
  },
);

test("an absent guard that answers 401 logs out and writes nothing", async () => {
  const { plans, session, requests } = await loggedIn(
    json({ message: "Session expired!" }, { status: 401 }),
  );
  const { token } = plans.createPlan({
    summary: "Add Ben to group 5",
    changes: [{ method: "PUT", path: "/groups/5/members/1", body: {} }],
    guards: [{ path: "/groups/5/members/1", absent: true }],
  });

  const message = await messageOf(plans.executePlan(token));

  expect(message).toContain(loginRequired);
  expect(session.state()).toEqual({ state: "logged_out" });
  expect(requests()).toEqual([`GET ${api}/groups/5/members/1`]);
});

test("duplicate guards on one path are each re-read before the write", async () => {
  const { plans, requests } = await loggedIn(
    json({ data: person }),
    json({ data: person }),
    json({ data: {} }),
  );
  const { token } = plans.createPlan({
    ...guarded(person),
    guards: [
      { path: "/persons/1", data: person },
      { path: "/persons/1", data: { ...person } },
    ],
  });

  await plans.executePlan(token);

  expect(requests()).toEqual([
    `GET ${api}/persons/1`,
    `GET ${api}/persons/1`,
    `PATCH ${api}/persons/1`,
  ]);
});

test("two guards on one path that contradict each other abort with zero writes", async () => {
  const { plans, requests } = await loggedIn(
    json({ data: person }),
    json({ data: person }),
  );
  const { token } = plans.createPlan({
    ...guarded(person),
    guards: [
      { path: "/persons/1", data: person },
      { path: "/persons/1", data: { ...person, email: "x@example.org" } },
    ],
  });

  const message = await messageOf(plans.executePlan(token));

  expect(message).toContain("Nothing was written");
  expect(requests()).toEqual([`GET ${api}/persons/1`, `GET ${api}/persons/1`]);
});

// Execution

test("a session that expires exactly between guard and write reports nothing written and logs out", async () => {
  const { plans, session, requests } = await loggedIn(
    json({ data: person }),
    json({ message: "Session expired!" }, { status: 401 }),
  );
  const { token } = plans.createPlan(guarded(person));

  const message = await messageOf(plans.executePlan(token));

  expect(message).toContain(
    `Change 1 of 1 (PATCH /persons/1) failed: ${loginRequired}`,
  );
  expect(message).toContain("Written: nothing");
  expect(message).not.toContain("may still have been applied");
  expect(session.state()).toEqual({ state: "logged_out" });
  expect(requests()).toEqual([
    `GET ${api}/persons/1`,
    `PATCH ${api}/persons/1`,
  ]);
});

test("the write carries cookie and CSRF token; the guard read carries the cookie only", async () => {
  const { plans, calls } = await loggedIn(
    json({ data: person }),
    json({ data: {} }),
  );
  const { token } = plans.createPlan(guarded(person));

  await plans.executePlan(token);

  expect(calls[0]?.headers.get("csrf-token")).toBeNull();
  expect(calls[0]?.headers.get("cookie")).toContain(cookieValue);
  expect(calls[1]?.headers.get("csrf-token")).toBe(csrfToken);
  expect(calls[1]?.headers.get("cookie")).toContain(cookieValue);
});

test("a write that answers 2xx with an error body is passed on unchanged as the result", async () => {
  const errorBody = {
    message: "Validation failed",
    errors: [{ fieldId: "email" }],
  };
  const { plans } = await loggedIn(json({ data: person }), json(errorBody));
  const { token } = plans.createPlan(guarded(person));

  const result = await plans.executePlan(token);

  expect(result.results).toEqual([
    { request: "PATCH /persons/1", result: errorBody },
  ]);
});

test("a plan with zero changes re-reads its guards and writes nothing", async () => {
  const { plans, requests } = await loggedIn(json({ data: person }));
  const { token, preview } = plans.createPlan({
    ...guarded(person),
    changes: [],
  });

  const result = await plans.executePlan(token);

  expect(preview.changes).toEqual([]);
  expect(result.results).toEqual([]);
  expect(requests()).toEqual([`GET ${api}/persons/1`]);
});

test("a failed write whose raw error page echoes the session cookie keeps the cookie out of the report", async () => {
  const { plans } = await loggedIn(
    json({ data: person }),
    new Response(`<pre>Cookie: ChurchTools_ct=${cookieValue}</pre>`, {
      status: 500,
    }),
  );
  const { token } = plans.createPlan(guarded(person));

  const message = await messageOf(plans.executePlan(token));

  expect(message).toContain("Change 1 of 1");
  expect(message).not.toContain(cookieValue);
});

test("a change body that contains the CSRF value is sent as given and the preview shows it unchanged", async () => {
  const { plans, calls } = await loggedIn(
    json({ data: person }),
    json({ data: {} }),
  );
  const { token, preview } = plans.createPlan({
    ...guarded(person),
    changes: [{ ...patch, body: { note: csrfToken } }],
  });

  await plans.executePlan(token);

  expect(calls[1]?.body).toEqual({ note: csrfToken });
  expect(preview.changes[0]).toMatchObject({
    fields: { note: { after: csrfToken } },
  });
});

// Previews

test("a nested object that differs only in key order is no change in the preview", () => {
  const preview = previewOf({
    method: "PUT",
    path: "/persons/1",
    body: { address: { street: "A", city: "X" }, email: "new@example.org" },
    before: { address: { city: "X", street: "A" }, email: "old@example.org" },
  });

  expect(preview).toEqual({
    method: "PUT",
    path: "/persons/1",
    fields: {
      email: { before: "old@example.org", after: "new@example.org" },
    },
  });
});

test("a changed nested object and a reordered array show before and after in full", () => {
  const preview = previewOf({
    method: "PUT",
    path: "/persons/1",
    body: { address: { city: "Y" }, tags: [2, 1] },
    before: { address: { city: "X" }, tags: [1, 2] },
  });

  expect(preview).toEqual({
    method: "PUT",
    path: "/persons/1",
    fields: {
      address: { before: { city: "X" }, after: { city: "Y" } },
      tags: { before: [1, 2], after: [2, 1] },
    },
  });
});

test("an update whose body is an array still shows the record before", () => {
  const preview = previewOf({
    method: "PUT",
    path: "/groups/5/roles",
    body: [{ id: 1 }, { id: 2 }],
    before: [{ id: 1 }],
  });

  expect(JSON.stringify(preview)).toContain('"before"');
});

test("a field the write sets to null is listed even when the record had no such key", () => {
  const preview = previewOf({
    method: "PATCH",
    path: "/persons/1",
    body: { nickname: null },
    before: person,
  });

  expect(preview).toMatchObject({ fields: { nickname: { after: null } } });
});

test("a field whose value is undefined is not sent, so the preview does not list it", () => {
  const preview = previewOf({
    method: "PATCH",
    path: "/persons/1",
    body: { email: undefined, firstName: "Benjamin" },
    before: person,
  });

  expect(preview).toEqual({
    method: "PATCH",
    path: "/persons/1",
    fields: { firstName: { before: "Ben", after: "Benjamin" } },
  });
});

test("a preview of a very large create lists every field", () => {
  const body: Record<string, string> = {};
  for (let i = 0; i < 5000; i++) body[`field${i}`] = "x".repeat(100);

  const preview = previewOf({ method: "POST", path: "/persons", body });

  expect(Object.keys((preview as { fields: object }).fields)).toHaveLength(
    5000,
  );
});

// Deferred to step 6 (advisor): only ct_api_request can send a DELETE body.
test("a delete preview shows the body the delete sends", () => {
  const preview = previewOf({
    method: "DELETE",
    path: "/persons/1",
    body: { reason: "duplicate" },
    before: person,
  });

  expect(JSON.stringify(preview)).toContain("duplicate");
});
