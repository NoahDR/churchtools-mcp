---
paths:
  - "src/**/*.ts"
---

# ChurchTools code

- **Lenient reads.** ChurchTools is PHP: an empty object arrives as `[]`, an absent field as `null` or not
  at all. Read nested objects with `.catch({})` and fields with `.nullish()`, as `nested` in
  `src/tools/groups.ts` does, so one odd field leaves the rest of the answer readable.
- **Deprecated aliases.** A GET answer can carry an old name beside the current one (`caption` and `title`,
  `agreed` and `isAccepted`, `information.maxMembers` and `settings.maxMembers`). Read the current name
  first. Build a write body from the operation's request schema in the spec. A PUT that replaces the whole
  record starts from the GET answer without its aliases, as `withoutAliases` in `src/tools/calendars.ts` does.
- **Safe error text.** A tool body runs inside `toolResult`, and every error text comes from `errorText`:
  a raw response body can echo the password.
- **Refines after `.pipe(z.url())`** still run when the URL check failed. Parse with `URL.parse`, which
  returns `null`; `new URL` throws.
