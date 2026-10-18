# churchtools-mcp

[![CI](https://github.com/NoahDR/churchtools-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/NoahDR/churchtools-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An MCP server for [ChurchTools](https://church.tools), the church management software. It gives Claude Code
(or any MCP client) tools to read and change persons, groups, calendars and events of one ChurchTools
instance, and reaches every other endpoint through the instance's OpenAPI spec. It acts with the rights of
the logged-in user. Every write shows a preview first and runs only after you approve it.

> [!NOTE]
> This is a community project. It is not made, endorsed or supported by ChurchTools Innovations GmbH.
> "ChurchTools" is their name and is used here only to say which software the server talks to.

## Setup

Requires Node 26 (`.nvmrc`).

1. Clone the repository, then install and build:

   ```
   npm ci
   npm run build
   ```

2. Copy `.env.example` to `.env` and fill in `CT_URL` (https only), `CT_USERNAME` and `CT_PASSWORD`.
   Keep every value in double quotes: unquoted, a `#` starts a comment and cuts the value. `.env` stays
   out of git.
3. Register the server with your MCP client.
   - **Claude Code in this repository:** start `claude` in the repository root and approve the project
     MCP server `churchtools` from `.mcp.json` once. `claude mcp get churchtools` shows the connection state.
   - **Claude Code everywhere:** `claude mcp add --scope user churchtools -- node --env-file=/path/to/churchtools-mcp/.env /path/to/churchtools-mcp/dist/index.js`
   - **Other clients:** start `node --env-file=/path/to/churchtools-mcp/.env /path/to/churchtools-mcp/dist/index.js` over stdio.

## Log in

The server starts logged out and keeps the session in memory only. Ask Claude to log in: it calls
`ct_status`, asks you for the current 2FA code from your authenticator app and calls `ct_login` with it.
A ChurchTools session usually lasts a day; log in again when a tool reports the session expired.

## Writes: the plan flow

A write tool changes nothing. It returns a plan: a preview of each request with the record as it is now,
and a token. After you approve the preview, `ct_execute_plan` runs it. A token is valid once, for 10
minutes. Before writing, the server re-reads every record it can read back; if one changed since the preview,
nothing is written. A generic write to a path without a GET has no such check.

## Security

- The server sees what your ChurchTools user sees. Use an account with only the rights you need, and with
  2FA on.
- Member data from ChurchTools goes to the model provider of your MCP client. Check that this fits your
  church's data protection rules before you use it with real data.
- Text in ChurchTools records (notes, descriptions) reaches the model and can try to steer it. The plan flow
  keeps every write behind your approval: read each preview before you approve it.
- How the server handles credentials, and how to report a vulnerability: [SECURITY.md](SECURITY.md).

## Tools

| Group        | Tools                                                                                                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session      | `ct_status`, `ct_login`                                                                                                                                                                         |
| Plans        | `ct_execute_plan`                                                                                                                                                                               |
| Any endpoint | `ct_search_api`, `ct_get_operation`, `ct_api_request`                                                                                                                                           |
| Persons      | `ct_search_persons`, `ct_get_person`, `ct_create_person`, `ct_update_person`, `ct_delete_person`                                                                                                |
| Groups       | `ct_search_groups`, `ct_get_group`, `ct_create_group`, `ct_update_group`, `ct_delete_group`, `ct_list_group_members`, `ct_add_group_member`, `ct_update_group_member`, `ct_remove_group_member` |
| Calendars    | `ct_list_calendars`, `ct_list_appointments`, `ct_get_appointment`, `ct_create_appointment`, `ct_update_appointment`, `ct_delete_appointment`                                                    |
| Events       | `ct_list_events`, `ct_get_event`, `ct_list_services`, `ct_update_event`, `ct_delete_event`, `ct_assign_event_service`, `ct_set_external_event_service`                                          |

## Not included

- HTTP transport, several instances, npm package: it runs locally over stdio against one instance.
- Bulk writes and an audit log: one record per write; ChurchTools keeps its own history.
- OAuth and persistent login tokens: the login is password plus 2FA code, per session.
- Curated tools for finance, songs, wiki, resources, check-in and absences: use `ct_api_request`.
- A tool to create events: `ct_create_appointment` creates them from an event template through
  `fields.events` ([docs/churchtools-api.md](docs/churchtools-api.md)).
- Splitting an appointment series, editing or deleting a single occurrence, change-impact reports.
- Event service counts, 2FA enrolment, anonymising personal data.

## Develop

[`CLAUDE.md`](CLAUDE.md) holds the build, check and live-test commands and the repository's rules.
`npm run check` must pass; CI runs it on every push and pull request.

## Remove

Delete the `churchtools` entry from your MCP client, then delete `.env` and the cached API spec in
`~/.cache/churchtools-mcp`. Nothing stays in ChurchTools besides the ended login session.

## License

[MIT](LICENSE)
