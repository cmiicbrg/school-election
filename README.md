# school-election

Self-hosted system for anonymous, in-person school elections: Schulsprecher-, Abteilungssprecher- and Klassensprecherwahl under the Austrian regulation, plus other anonymous school votes.

Students draw an anonymous voting key at the polling place, scan its QR code and vote on their own phone. Teachers and student witnesses sign in with Microsoft Entra ID; voters do not. The data model keeps ballots unlinkable to keys and to each other.

## Development

Requires Node 26.

```bash
npm ci --ignore-scripts
cp apps/api/.env.example apps/api/.env
npm run dev:api     # http://127.0.0.1:3000
npm run dev:web     # Vite dev server, /api proxied to the API
npm run lint
npm test
```

### Browser journeys

`npm run e2e` runs the Playwright journeys in `e2e/specs` in Chromium against the real server, started by `e2e/harness/server.ts` with a fresh database and a stand-in for the Microsoft sign-in. It needs `TEST_DATABASE_URL` like the API tests, and Chromium once: `npm run e2e:install`. The specs of a file build on each other and the files on the ones before, so run them in order; `npm run e2e:ui` opens Playwright's UI, and the VS Code Playwright extension finds `playwright.config.ts` at the repository root. `npm run e2e:screenshots` writes the screenshots for the teacher's guide to `docs/anleitung/bilder/`. The browser console must stay clean: a message at warning or error level, or an uncaught exception, in any page of a journey fails the test it happened in; a refusal a spec provokes on purpose is declared with `refused` from `e2e/support/console.ts`.

## Container image

One image runs the API and serves the built web app as a non-root user (uid 10001).

```bash
docker build -t school-election:local .
docker run --rm -p 127.0.0.1:3000:3000 school-election:local
```

Release images are published to `ghcr.io/cmiicbrg/school-election` when a `v*` tag is pushed. The workflow summary prints the `IMAGE` value, tag and digest, to pin in the deployment's `.env`.

## Deployment

[deploy/README.md](deploy/README.md) is the operator guide: the Entra ID app registration, secret files, a rootless podman compose stack with PostgreSQL, nginx in front, updates, reboots and backups. The examples it uses live next to it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). The container image also contains libvips, a shared library under the LGPL-3.0-or-later that the API uses to re-encode candidate pictures; [third-party-notices](third-party-notices/README.md) has its notice, source and license texts, and the image carries them as `/app/third-party-notices`.
