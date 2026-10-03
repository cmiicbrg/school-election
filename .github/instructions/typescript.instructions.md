---
applyTo: "**/*.{ts,js,mjs,vue}"
---

# TypeScript / Vue instructions (ESLint)

## Goals

- Favor clear, maintainable code over clever tricks.
- Avoid unrelated refactors or style churn.

## Linting and verification

- Keep changes clean under `npm run lint` (ESLint, markdownlint, `lint:deps`, typecheck). The repository formats code through ESLint's stylistic rules; there is no Prettier.
- Fix the underlying issue rather than adding `eslint-disable`. A suppression needs a comment with the reason.
- Pin every dependency to an exact version in the `package.json` of the workspace that uses it. `npm run lint:deps` enforces it.

## Repository rules

- `packages/election-core` stays pure: no Node, HTTP, database, session or Vue imports. ESLint enforces it.
- The API runs as raw TypeScript on Node 26 (type stripping): no enums, namespaces or parameter properties, and relative imports carry the `.ts` extension.
- Validate external input at the API boundary. The browser is never authoritative for ballot integrity.
- Never log a voting key or ballot content, and never put either into a URL path or query string, an export or the audit log. Keys are stored only where they are issued, as generated, never next to a ballot, a session or an audit event.
