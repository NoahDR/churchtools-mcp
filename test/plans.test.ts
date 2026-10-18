import { afterEach, expect, test, vi } from "vitest";
import { createSession, loginRequired } from "../src/ct/session.js";
import { PlanError, type PlanInput, createPlans } from "../src/plans.js";
import {
  code,
  env,
  fakeFetch,
  json,
  loginAnswers,
  secrets,
} from "./fake-fetch.js";

afterEach(() => {
  vi.useRealTimers();
});

const api = "/churchtools/api";
const person = { id: 1, firstName: "Ben", email: "ben@example.org" };
const notFound = () => json({ message: "Not found" }, { status: 404 });

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

function expectNoSecrets(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of secrets) expect(text).not.toContain(secret);
}

const update: PlanInput = {
  summary: "Change Ben's e-mail",
  changes: [
    {
      method: "PATCH",
      path: "/persons/1",
      body: { email: "ben@new.org" },
      before: person,
    },
  ],
  guards: [{ path: "/persons/1", data: person }],
};

// Preview

test("createPlan returns a UUID token and a preview without any request", async () => {
  const { plans, calls } = await loggedIn();

  const { token, preview } = plans.createPlan(update);

  expect(token).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(preview.summary).toBe("Change Ben's e-mail");
  expect(calls).toHaveLength(0);
});

test("an update preview shows before and after of each changed field only", async () => {
  const { plans } = await loggedIn();

  const { preview } = plans.createPlan({
    ...update,
    changes: [
      {
        method: "PUT",
        path: "/persons/1",
        body: { ...person, email: "ben@new.org", nickname: "Benny" },
        before: person,
      },
    ],
  });

  expect(preview.changes).toEqual([
    {
      method: "PUT",
      path: "/persons/1",
      fields: {
        email: { before: "ben@example.org", after: "ben@new.org" },
        nickname: { before: "(absent)", after: "Benny" },
      },
    },
  ]);
});

test("a create preview shows every field of the body", async () => {
  const { plans } = await loggedIn();

  const { preview } = plans.createPlan({
    summary: "Add Ben to group 5",
    changes: [
      {
        method: "PUT",
        path: "/groups/5/members/1",
        body: { groupTypeRoleId: 8, groupMemberStatus: "active" },
      },
    ],
    guards: [{ path: "/groups/5/members/1", absent: true }],
  });

  expect(preview.changes).toEqual([
    {
      method: "PUT",
      path: "/groups/5/members/1",
      fields: {
        groupTypeRoleId: { after: 8 },
        groupMemberStatus: { after: "active" },
      },
    },
  ]);
});

test("a delete preview shows the whole record and the query", async () => {
  const { plans } = await loggedIn();

  const { preview } = plans.createPlan({
    summary: "Delete Ben",
    changes: [
      {
        method: "DELETE",
        path: "/persons/1",
        query: { sendMail: false },
        before: person,
      },
    ],
    guards: [{ path: "/persons/1", data: person }],
  });

  expect(preview.changes).toEqual([
    {
      method: "DELETE",
      path: "/persons/1",
      query: { sendMail: false },
      record: person,
    },
  ]);
});

test("the preview tells Claude to ask the user before ct_execute_plan", async () => {
  const { plans } = await loggedIn();

  const { preview } = plans.createPlan(update);

  expect(preview.next).toContain("ct_execute_plan");
});

// Token

test("an unknown token is rejected without a request", async () => {
  const { plans, calls } = await loggedIn();

  const message = await messageOf(plans.executePlan(crypto.randomUUID()));

  expect(message).toMatch(/unknown, expired or already used/);
  expect(calls).toHaveLength(0);
});

test("a token is single use", async () => {
  const { plans, requests } = await loggedIn(
    json({ data: person }),
    json({ data: { ...person, email: "ben@new.org" } }),
  );
  const { token } = plans.createPlan(update);
  await plans.executePlan(token);

  const message = await messageOf(plans.executePlan(token));

  expect(message).toMatch(/unknown, expired or already used/);
  expect(requests()).toEqual([
    `GET ${api}/persons/1`,
    `PATCH ${api}/persons/1`,
  ]);
});

test("two parallel executions of one token run the plan exactly once", async () => {
  const { plans, requests } = await loggedIn(
    json({ data: person }),
    json({ data: {} }),
  );
  const { token } = plans.createPlan(update);

  const results = await Promise.allSettled([
    plans.executePlan(token),
    plans.executePlan(token),
  ]);

  expect(results.map((r) => r.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(requests().filter((r) => r.startsWith("PATCH"))).toHaveLength(1);
});

test("a token works up to 1 ms before 10 minutes and is expired at exactly 10 minutes", async () => {
  const { plans, requests } = await loggedIn(
    json({ data: person }),
    json({ data: {} }),
  );
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.now();
  const early = plans.createPlan(update).token;
  const late = plans.createPlan(update).token;

  vi.setSystemTime(start + 10 * 60_000 - 1);
  await plans.executePlan(early);
  vi.setSystemTime(start + 10 * 60_000);
  const message = await messageOf(plans.executePlan(late));

  expect(message).toMatch(/unknown, expired or already used/);
  expect(requests()).toEqual([
    `GET ${api}/persons/1`,
    `PATCH ${api}/persons/1`,
  ]);
});

test("plans live in their own store: a token of one store is unknown in a fresh one", async () => {
  const first = await loggedIn();
  const second = await loggedIn();
  const { token } = first.plans.createPlan(update);

  const message = await messageOf(second.plans.executePlan(token));

  expect(message).toMatch(/unknown/);
  expect(second.calls).toHaveLength(0);
});

// Guards

test("the guard hash ignores key order, also nested", async () => {
  const stored = { a: 1, b: { c: 2, d: [1, 2] } };
  const { plans, requests } = await loggedIn(
    json({ data: { b: { d: [1, 2], c: 2 }, a: 1 } }),
    json({ data: {} }),
  );
  const { token } = plans.createPlan({
    ...update,
    guards: [{ path: "/persons/1", data: stored }],
  });

  await plans.executePlan(token);

  expect(requests()).toContain(`PATCH ${api}/persons/1`);
});

test("the guard hash keeps array order: a reordered array is a change", async () => {
  const { plans, requests } = await loggedIn(
    json({ data: { a: 1, b: { d: [2, 1] } } }),
  );
  const { token } = plans.createPlan({
    ...update,
    guards: [{ path: "/persons/1", data: { a: 1, b: { d: [1, 2] } } }],
  });

  const message = await messageOf(plans.executePlan(token));

  expect(message).toContain("fields: b");
  expect(requests()).toEqual([`GET ${api}/persons/1`]);
});

test("a changed record aborts with zero writes and names only the changed fields", async () => {
  const { plans, requests } = await loggedIn(
    json({ data: { ...person, email: "other@example.org", phone: "1" } }),
  );
  const { token } = plans.createPlan(update);

  const message = await messageOf(plans.executePlan(token));

  expect(message).toContain("Nothing was written");
  expect(message).toContain("fields: email, phone");
  expect(message).not.toContain("firstName");
  expect(requests()).toEqual([`GET ${api}/persons/1`]);
});

test("a hash guard whose record is gone (404) aborts with zero writes", async () => {
  const { plans, requests } = await loggedIn(notFound());
  const { token } = plans.createPlan(update);

  const message = await messageOf(plans.executePlan(token));

  expect(message).toContain("Nothing was written");
  expect(message).toContain("no longer exists");
  expect(requests()).toEqual([`GET ${api}/persons/1`]);
});

const addMember: PlanInput = {
  summary: "Add Ben to group 5",
  changes: [
    {
      method: "PUT",
      path: "/groups/5/members/1",
      body: { groupTypeRoleId: 8 },
    },
  ],
  guards: [{ path: "/groups/5/members/1", absent: true }],
};

test("an absent guard that reads 200 aborts with zero writes", async () => {
  const { plans, requests } = await loggedIn(json({ data: { personId: 1 } }));
  const { token } = plans.createPlan(addMember);

  const message = await messageOf(plans.executePlan(token));

  expect(message).toContain("Nothing was written");
  expect(message).toContain("exists now");
  expect(requests()).toEqual([`GET ${api}/groups/5/members/1`]);
});

test("an absent guard that reads 404 lets the write run", async () => {
  const { plans, requests, calls } = await loggedIn(
    notFound(),
    json({ data: { personId: 1, groupTypeRoleId: 8 } }),
  );
  const { token } = plans.createPlan(addMember);

  const result = await plans.executePlan(token);

  expect(requests()).toEqual([
    `GET ${api}/groups/5/members/1`,
    `PUT ${api}/groups/5/members/1`,
  ]);
  expect(calls[1]?.body).toEqual({ groupTypeRoleId: 8 });
  expect(result.results).toEqual([
    {
      request: "PUT /groups/5/members/1",
      result: { data: { personId: 1, groupTypeRoleId: 8 } },
    },
  ]);
});

test("a guard read that fails on the network aborts with zero writes", async () => {
  const { plans, requests } = await loggedIn(new TypeError("fetch failed"));
  const { token } = plans.createPlan(update);

  const message = await messageOf(plans.executePlan(token));

  expect(message).toContain("Nothing was written");
  expect(message).toContain("fetch failed");
  expect(requests()).toEqual([`GET ${api}/persons/1`]);
});

test("a guard read with another error status (500) aborts with zero writes", async () => {
  const { plans, requests } = await loggedIn(
    json({ message: "Boom" }, { status: 500 }),
  );
  const { token } = plans.createPlan(update);

  const message = await messageOf(plans.executePlan(token));

  expect(message).toContain("Nothing was written");
  expect(message).toContain("Boom");
  expect(requests()).toEqual([`GET ${api}/persons/1`]);
});

test("a session that expired after the preview: 401 on the guard logs out and writes nothing", async () => {
  const { plans, session, requests } = await loggedIn(
    json({ message: "Session expired!" }, { status: 401 }),
  );
  const { token } = plans.createPlan(update);

  const message = await messageOf(plans.executePlan(token));

  expect(message).toContain("Nothing was written");
  expect(message).toContain(loginRequired);
  expect(session.state()).toEqual({ state: "logged_out" });
  expect(requests()).toEqual([`GET ${api}/persons/1`]);
});

test("a logged-out session executes nothing and asks for ct_login", async () => {
  const { fetch, calls } = fakeFetch();
  const plans = createPlans(createSession({ env, fetch }));
  const { token } = plans.createPlan(update);

  const message = await messageOf(plans.executePlan(token));

  expect(message).toContain(loginRequired);
  expect(calls).toHaveLength(0);
});

test("every guard is checked before the first write", async () => {
  const other = { id: 2 };
  const { plans, requests } = await loggedIn(
    json({ data: person }),
    json({ data: { id: 2, changed: true } }),
  );
  const { token } = plans.createPlan({
    ...update,
    guards: [...update.guards, { path: "/persons/2", data: other }],
  });

  await messageOf(plans.executePlan(token));

  expect(requests()).toEqual([`GET ${api}/persons/1`, `GET ${api}/persons/2`]);
});

// Execution

test("a plan runs its write with method, path, query and body and returns the result", async () => {
  const { plans, calls } = await loggedIn(
    json({ data: person }),
    json({ data: { ...person, email: "ben@new.org" } }),
  );
  const { token } = plans.createPlan({
    ...update,
    changes: [{ ...update.changes[0], query: { force: false } }],
  });

  const result = await plans.executePlan(token);

  expect(calls[1]).toMatchObject({
    method: "PATCH",
    path: `${api}/persons/1?force=false`,
    body: { email: "ben@new.org" },
  });
  expect(result).toEqual({
    executed: "Change Ben's e-mail",
    results: [
      {
        request: "PATCH /persons/1",
        result: { data: { ...person, email: "ben@new.org" } },
      },
    ],
  });
});

test("changing the input after createPlan changes neither the write nor the guard", async () => {
  const { plans, calls } = await loggedIn(
    json({ data: person }),
    json({ data: {} }),
  );
  const input = structuredClone(update);
  const { token } = plans.createPlan(input);
  (input.changes[0].body as { email: string }).email = "evil@example.org";
  (input.guards[0] as { data: { email: string } }).data.email = "x";

  await plans.executePlan(token);

  expect(calls[1]?.body).toEqual({ email: "ben@new.org" });
});

const twoDeletes: PlanInput = {
  summary: "Delete two persons",
  changes: [
    { method: "DELETE", path: "/persons/1", before: person },
    { method: "DELETE", path: "/persons/2", before: { id: 2 } },
  ],
  guards: [],
};

test("when the first change fails nothing else runs and the report says nothing was written", async () => {
  const { plans, requests } = await loggedIn(
    json(
      { message: "Forbidden", translatedMessage: "Verboten" },
      { status: 403 },
    ),
  );
  const { token } = plans.createPlan(twoDeletes);

  const message = await messageOf(plans.executePlan(token));

  expect(message).toContain(
    "Change 1 of 2 (DELETE /persons/1) failed: Verboten",
  );
  expect(message).toContain("Written: nothing");
  expect(message).toContain("Not run: DELETE /persons/2");
  expect(requests()).toEqual([`DELETE ${api}/persons/1`]);
});

test("when the second of two changes fails the report says the first was written", async () => {
  const { plans, requests } = await loggedIn(
    new Response(null, { status: 204 }),
    json({ message: "Not found" }, { status: 404 }),
  );
  const { token } = plans.createPlan(twoDeletes);

  const message = await messageOf(plans.executePlan(token));

  expect(message).toContain(
    "Change 2 of 2 (DELETE /persons/2) failed: Not found",
  );
  expect(message).toContain("Written: DELETE /persons/1");
  expect(message).toContain("Not run: nothing");
  expect(message).not.toContain("may still have been applied");
  expect(requests()).toEqual([
    `DELETE ${api}/persons/1`,
    `DELETE ${api}/persons/2`,
  ]);
});

test("a write lost on the network is reported as possibly applied", async () => {
  const { plans } = await loggedIn(new TypeError("fetch failed"));
  const { token } = plans.createPlan(twoDeletes);

  const message = await messageOf(plans.executePlan(token));

  expect(message).toContain("fetch failed");
  expect(message).toContain("may still have been applied");
});

test("a session that expires mid-plan reports the written change and logs out", async () => {
  const { plans, session } = await loggedIn(
    new Response(null, { status: 204 }),
    json({ message: "Session expired!" }, { status: 401 }),
  );
  const { token } = plans.createPlan(twoDeletes);

  const message = await messageOf(plans.executePlan(token));

  expect(message).toContain("Written: DELETE /persons/1");
  expect(message).toContain(loginRequired);
  expect(message).not.toContain("may still have been applied");
  expect(session.state()).toEqual({ state: "logged_out" });
});

// Secrets

test("neither preview, result nor failure report contains the cookie, CSRF token, password or code", async () => {
  const { plans } = await loggedIn(
    json({ data: person }),
    json({ data: person }),
    json({ data: person }),
    json({ message: "Boom" }, { status: 500 }),
  );
  const ok = plans.createPlan(update);
  const failing = plans.createPlan(update);

  const result = await plans.executePlan(ok.token);
  const message = await messageOf(plans.executePlan(failing.token));

  expectNoSecrets([ok.preview, failing.preview, result, message]);
});

test("creating a plan drops every expired plan from memory", async () => {
  const { plans } = await loggedIn();
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.now();
  plans.createPlan(update);

  vi.setSystemTime(start + 10 * 60_000);
  plans.createPlan(update);

  expect(plans.size()).toBe(1);
});

test.each([500, 502, 504])(
  "a write answered %i is reported as possibly applied",
  async (status) => {
    const { plans } = await loggedIn(json({ message: "Gateway" }, { status }));
    const { token } = plans.createPlan(twoDeletes);

    const message = await messageOf(plans.executePlan(token));

    expect(message).toContain("failed: Gateway");
    expect(message).toContain("may still have been applied");
  },
);

test("a failed write keeps the server's errors[] and args as structured details", async () => {
  const { plans } = await loggedIn(
    json(
      {
        message: "Duplicate",
        args: { duplicatePersonId: 42 },
        errors: [{ fieldId: "email", message: "taken", messageKey: "k" }],
      },
      { status: 400 },
    ),
  );
  const { token } = plans.createPlan({
    summary: "Create Ben",
    changes: [{ method: "POST", path: "/persons", body: { firstName: "B" } }],
    guards: [],
  });

  const error: unknown = await plans
    .executePlan(token)
    .catch((e: unknown) => e);

  expect(error).toBeInstanceOf(PlanError);
  expect((error as PlanError).details).toEqual({
    args: { duplicatePersonId: 42 },
    errors: [{ fieldId: "email", message: "taken", messageKey: "k" }],
  });
});
