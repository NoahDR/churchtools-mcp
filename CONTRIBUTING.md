# Contributing

Thanks for helping. Bug reports, fixes and new tools are welcome.

## Before you start

- **Security problem?** Do not open an issue. Report it privately: [SECURITY.md](SECURITY.md).
- **Bigger change?** Open an issue first, so we agree on the shape before you write code.
- **Never paste real member data or credentials** into an issue, a test or a fixture. Use made-up names and
  `example.org` addresses.

## Set up

```bash
npm ci
npm run check
```

`npm run check` runs types, lint, format, build and all unit tests, including an end-to-end test over
stdio. It must pass before a pull request can merge.

Live tests (`npm run test:live`) write to a throwaway ChurchTools trial instance configured in `.env.live`.
They never run against a production instance; [`CLAUDE.md`](CLAUDE.md) explains the setup. You do not need
them for a pull request.

## Pull requests

- One topic per pull request, with a test that fails without the change.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org): `fix: …`, `feat: …`.
- Read [`docs/churchtools-api.md`](docs/churchtools-api.md) before code calls a new endpoint: it lists the
  places where ChurchTools behaves differently from its spec.
- Every write goes through the plan flow (preview first, `ct_execute_plan` second). A tool that writes
  directly will not be merged.
- New dependencies need a good reason. The fewer packages the server pulls in, the smaller the attack
  surface.

By contributing, you agree that your work is released under the [MIT License](LICENSE).
