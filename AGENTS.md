# Agent instructions

Self-hosted system for anonymous, in-person school elections. Read the invariants below before changing election behaviour, and [`docs/design.md`](docs/design.md) for the reasoning behind the election model.

## Layout

```text
packages/election-core/   pure domain: rulesets, ballot validation, counting (no I/O, no clock, no randomness)
apps/api/                 Fastify on Node 26, raw TypeScript; serves apps/web/dist
apps/web/                 Vue 3 + Vite SPA
apps/api/migrations/      forward-only SQL migrations, applied by apps/api/scripts/migrate.ts
scripts/lint-deps.mjs     exact-pin check across all workspaces
scripts/postgres.sh       PostgreSQL with the settings the API requires (CI and development)
docs/design.md            design decisions; update it with the behaviour it describes
```

npm workspaces share one root `package-lock.json`. Shared tooling (ESLint, TypeScript, markdownlint) lives in the root `package.json`; runtime dependencies live in the workspace that uses them.

## Commands

```bash
npm ci --ignore-scripts
npm run lint        # ESLint + markdownlint + lint:deps + typecheck
npm test            # node:test in every workspace; database tests need TEST_DATABASE_URL
npm run migrate     # apply pending migrations as the database owner
npm run build       # web app → apps/web/dist
npm run dev:api     # API on :3000
npm run dev:web     # Vite dev server, proxies /api to :3000
```

## Invariants

These take precedence over convenience:

- Ballots are never persistently linked to a credential, entitlement, session, user or each other (no timestamps or request metadata on ballots).
- Raw credentials never reach the database, logs or a server-visible URL. QR codes carry them in the URL fragment.
- Statutory points are fixed (`6..1`, `2, 1`). Smaller candidate counts use a prefix and are never rescaled. A ranking with every active slot filled is a valid vote; one with empty slots is an invalid vote, cast only with the voter's explicit confirmation, and gives nobody points. "Nein" exists only in single-candidate contests. The majority base is the valid ballots.
- No hidden tiebreaks: a statutory lot is an explicit, audited human action.
- Authorization and security headers live in the application, never in nginx.

## Conventions

- Dependencies are pinned exactly; Dependabot lands bumps, and the automerge workflow holds them for a one-day quarantine.
- GitHub Actions are pinned by commit SHA with the version in a comment. The base image is pinned by tag and digest.
- CI runs on pull requests to `main`. Images are published to GHCR only on `v*` tags.
- Applied migrations are never edited; write a new one. A migration that creates tables adds an upgrade fixture in `apps/api/test/fixtures/upgrade/`.
- The PostgreSQL settings the API checks at startup (`apps/api/lib/db-settings.ts`) and the ones `scripts/postgres.sh` sets change together; a test enforces it.
