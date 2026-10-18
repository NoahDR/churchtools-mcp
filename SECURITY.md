# Security

This server holds the ChurchTools password of its user and reads a church's member data. Please report a
vulnerability privately, not in a public issue.

## Report a vulnerability

Open the repository's **Security** tab and choose **Report a vulnerability**. Describe the problem, the
steps to reproduce it and the impact. Leave real credentials and real member data out of the report.

You get an answer within a week. A fix goes into `main`; the advisory names you unless you prefer not.

## Supported versions

Only the latest commit on `main` gets fixes.

## What the server does with secrets

- It reads `CT_URL`, `CT_USERNAME` and `CT_PASSWORD` from the environment and sends them only to `CT_URL`,
  over https. It follows no redirect, so a request with the password cannot be passed on to another host.
- The 2FA code comes from the user per login. The session cookie stays in memory and ends with the process.
- Error texts never echo a raw response body, so a password the server sent cannot come back through a tool
  result.
- On disk it writes only the instance's OpenAPI spec, to `~/.cache/churchtools-mcp`. The spec holds no
  member data.
