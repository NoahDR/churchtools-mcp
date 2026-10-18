# churchtools-mcp

An MCP server for the ChurchTools API, the church management software: it gives MCP clients tools for
ChurchTools data. TypeScript on Node 26, MCP SDK v2, stdio, one instance configured in `.env`.

## Map

| Path                                           | What lives there                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/index.ts`                                 | entry: starts the server on stdio                                                   |
| `src/server.ts`                                | `createServer()`: registers every tool: session, plan, generic API and curated      |
| `src/config.ts`, `src/plans.ts`, `src/spec.ts` | `.env` settings; write plans with token and guard; the instance's OpenAPI spec      |
| `src/ct/`                                      | HTTP client (cookies, CSRF, errors) and the login session with 2FA                  |
| `src/tools/`                                   | curated tools for persons, groups, calendars and events                             |
| `test/`                                        | Vitest, mocked fetch (`fake-fetch.ts`); `e2e.stdio.test.ts` starts the built server |
| `docs/churchtools-api.md`                      | ChurchTools API traps the spec leaves out: read it before code calls an endpoint    |

## Build and check

```
npm ci            # installs the locked dependencies
npm run build     # compiles src/ to dist/, the code the MCP client starts
npm run check     # types, lint, format, build, all unit tests incl. the stdio end-to-end test
npm run test:live # writes to the trial instance in .env.live
```

**Live tests** write to a throwaway ChurchTools trial instance whose account has 2FA fully enabled. Its
`CT_LIVE_URL`, `CT_LIVE_USERNAME`, `CT_LIVE_PASSWORD` and `CT_LIVE_TOTP_SECRET` live in the git-ignored
`.env.live`; a variable left out skips every live test. Two logins within one 30 s 2FA step fail: the
second waits for the next code.

## How we work

- Base branch: main
- Branch: <type>/<topic>, for example feat/events-tool
- Commit: Conventional Commits
- Done: `npm run check` passes.
- When a step does not need the developer, keep going. Stop only when you cannot continue without them, or
  before anything destructive.

## Principles

1. **Think first.** State assumptions. If a request has two readings, name both and ask.
2. **Simple first.** The least code that solves the request; only what was asked.
3. **Surgical changes.** Touch only what the request needs. Match the local style. Remove only what your own change made unused.
4. **Goal-driven.** Turn the task into a check that can fail, then loop until it passes. Report only checks you ran.

## Boundaries

- ChurchTools credentials and API tokens stay out of git, in code, tests and fixtures alike: a leaked token
  opens a church's member data.
- `.env` and the session's `churchtools` MCP server reach the production church. Tests and every test write
  go through `.env.live` to the trial instance only.
- Session start with a 2FA code: if the developer's first message is or contains a 6-digit code, call
  `ct_login` with it at once, before anything else, and report the result. Never generate the code from a
  secret in `.env`.
