# Contributing

Thank you for helping. This project runs anonymous school elections, so correctness and ballot secrecy come before features. Please read this page before opening a pull request.

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems are reported privately, as described in [SECURITY.md](SECURITY.md), never in a public issue.

## Before you start

- For anything beyond a small fix, open an issue first and describe what you want to change. That avoids work on something that conflicts with the election model.
- The invariants in [`AGENTS.md`](AGENTS.md) (ballot unlinkability, no voting keys in logs, URLs, exports or the audit log, fixed statutory points, no hidden tiebreaks) are not open to trade-offs for convenience.
- Code, comments and documentation are in English. The user interface is in German.

## Setup

You need Node 26 (`nvm use` reads `.nvmrc`).

```bash
npm ci --ignore-scripts
cp apps/api/.env.example apps/api/.env

# PostgreSQL with the settings the API requires (CONTAINER_ENGINE=podman for Podman)
mkdir -p apps/api/.secrets
openssl rand -hex 24 > apps/api/.secrets/db-owner-password
openssl rand -hex 24 > apps/api/.secrets/db-runtime-password
openssl rand -hex 32 > apps/api/.secrets/session-key
printf 'not-a-real-secret' > apps/api/.secrets/entra-client-secret
scripts/postgres.sh school-election-db 5432 apps/api/.secrets/db-owner-password
npm run migrate

npm run dev:api     # API on http://127.0.0.1:3000
npm run dev:web     # Vite dev server on http://localhost:5173, /api proxied to the API
```

The API refuses to start with a missing or unsafe setting and names it. `apps/api/.env.example` lists every setting; secrets are never set inline but read from files named by `*_FILE` variables, kept in the git-ignored `apps/api/.secrets/`. Open the app through the Vite dev server: the API accepts state-changing requests only from `PUBLIC_ORIGIN`.

### Signing in during development

The dummy Entra values in `.env.example` are enough for everything except signing in. To sign in, use a development app registration in the school's tenant, separate from the one production uses, so the production registration lists only the production redirect URI and its client secret never leaves the server. The development registration: single tenant, platform Web, redirect URI `http://localhost:5173/api/auth/callback`, an app role with the value `teacher` assigned to your account, and a client secret. Put the tenant and client ids into `apps/api/.env` and the secret into `apps/api/.secrets/entra-client-secret`, then open <http://localhost:5173/api/auth/login>. The session cookies are `Secure` with the `__Host-` prefix, which Chrome, Edge and Firefox accept from `http://localhost`.

## Checks

Run these before pushing. CI runs the same ones on every pull request. The database tests need `TEST_DATABASE_URL`, a superuser connection to a server started with `scripts/postgres.sh`; each test file creates and drops its own database there. Without it they are skipped locally, and in CI they fail.

```bash
export TEST_DATABASE_URL="postgres://postgres:$(cat apps/api/.secrets/db-owner-password)@127.0.0.1:5432/postgres"
```

```bash
npm run lint        # ESLint, markdownlint, exact dependency pins, typecheck
npm test
npm run build
```

Formatting is enforced by ESLint; there is no separate formatter. `npx eslint . --fix` fixes most style findings.

## Pull requests

- Target `main` and keep each pull request to one concern. Small pull requests get reviewed faster.
- Write commit messages and pull request titles in the [Conventional Commits](https://www.conventionalcommits.org/) style, for example `feat(tally): runoff selection by first-round points` or `fix(api): reject ballots for closed rounds`.
- Add or update tests for behaviour changes. Changes to ballot validation or tallying need tests that cover the boundary cases.
- Explain in the description why the change is needed, not only what it does.

## Dependencies

- Add a dependency only when it clearly earns its place; every package is code that runs during an election.
- Pin exact versions (`npm install --save-exact`, which `.npmrc` already sets). `npm run lint:deps` rejects ranges.
- Dependencies must use a license compatible with MIT.
- Dependabot proposes updates; do not bump versions in unrelated pull requests.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE) of this project.
