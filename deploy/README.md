# Deploying school-election

A host runs PostgreSQL and the app as rootless podman systemd units from [`quadlet/`](quadlet/); the app listens on the host's loopback, `127.0.0.1:3000`, and speaks plain HTTP. TLS terminates outside the app, in a reverse proxy that reaches that port: on the same machine, or on another host through a tunnel. [`nginx.example.conf`](nginx.example.conf) is the pattern for the proxy, wherever it runs. The examples use `wahl.example.org` for the site, `election` for the user that runs the stack and `~/school-election` for its directory; replace them with your own.

The deployment updates itself. Both images are built, tested and signed by this repository and published under a line tag, `v1`; a release moves the line, and the host's nightly `podman auto-update` pulls it and restarts the units, the migrations first, never while a round accepts ballots. The host verifies the signature on every pull, so only an image that came through this repository's release workflow ever runs. Nothing on the host names a release, so nothing on the host goes stale; a major version (`v2`) is the one update an operator does by hand.

- `school-election-postgres` runs `ghcr.io/cmiicbrg/school-election-postgres`, PostgreSQL with exactly the settings the app checks at startup baked in ([`postgres/Dockerfile`](postgres/Dockerfile)). It is reachable only from an internal network, which has no route off the host: no published port, data in a named volume.
- `school-election` runs `ghcr.io/cmiicbrg/school-election`, read-only, without capabilities, listening on `127.0.0.1:3000` only. Before every start it runs the migrations with the same image. The image contains libvips, a shared library under the LGPL-3.0-or-later; its notice, source and license texts are in the image under `/app/third-party-notices` and in [`third-party-notices`](../third-party-notices/README.md).

## Entra ID app registration

Teachers and witnesses sign in with their school Microsoft accounts. In the Microsoft Entra admin center, under App registrations:

1. Register a new application for this tenant only ("Accounts in this organizational directory only") with the redirect URI `https://wahl.example.org/api/auth/callback`, platform Web. The redirect URI is always `PUBLIC_URL` followed by `/api/auth/callback`.
2. Its overview shows the Directory (tenant) ID and the Application (client) ID: `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID` in `.env`.
3. Under Certificates & secrets, create a client secret and keep its value (not its ID) for `secrets/entra-client-secret` below. Note the expiry date: after it, sign-in fails until a new secret is in the file and the app has been restarted.
4. Under App roles, create a role for users and groups with the value `teacher`. Only this value counts; the app ignores any other role. Under Enterprise applications, open the same application and assign the teacher role to the teachers under Users and groups. Teachers may create elections; everyone else sees only the elections they are a member of.
5. Witnesses are students and sign in without a role. If "Assignment required?" is set to Yes in the enterprise application's properties, they need an assignment too, or they cannot sign in.

No optional claims are needed. The app asks for `openid email profile` and takes the address from the `email` claim, or from `preferred_username` when there is none. If users in the tenant may not consent to applications themselves, add the delegated Microsoft Graph permissions `openid`, `email` and `profile` under API permissions and grant admin consent.

Development uses a separate registration in the school's tenant, with its own secret and the redirect URI `http://localhost:5173/api/auth/callback` (see `apps/api/.env.example`). Never add a localhost redirect URI to the production registration, and never use its secret anywhere else.

## Host

The host needs rootless podman 5 or newer (Debian 13 has it) and nothing else: no web server, no certificate. Create the user `election` without sudo rights, then let its units run without a login session and start at boot:

```bash
sudo loginctl enable-linger election
```

Every command in this guide except the ones on the proxy runs as `election`, in a real login session (ssh, or `sudo machinectl shell election@`); `sudo -u` does not provide the user session that `systemctl --user` and rootless podman need.

Fetch the units of the release you start from, the drop-in that keeps updates away from an election, the script it runs, and the `.env` template:

```bash
mkdir -p ~/school-election ~/.config/containers/systemd ~/.config/systemd/user/podman-auto-update.service.d
cd ~/school-election
tag=v1.0.0   # the release to start from; the units follow its line afterwards
base="https://raw.githubusercontent.com/cmiicbrg/school-election/$tag/deploy"
for unit in school-election.container school-election-postgres.container school-election-internal.network school-election-egress.network school-election-db.volume; do
  curl -fsSL -o ~/.config/containers/systemd/$unit "$base/quadlet/$unit"
done
curl -fsSL -o ~/.config/systemd/user/podman-auto-update.service.d/busy.conf "$base/systemd/podman-auto-update.service.d/busy.conf"
curl -fsSL -o not-busy.sh "$base/not-busy.sh" && chmod 755 not-busy.sh
curl -fsSL -o .env "$base/.env.example" && chmod 600 .env
systemctl --user daemon-reload
```

`daemon-reload` turns the Quadlet files into `school-election.service` and `school-election-postgres.service`. The units name no release: both images are pulled by their `v1` line tag.

### Signatures

Every image this repository publishes is signed with its cosign key; the public half is [`cosign.pub`](cosign.pub). Before the first pull, install it with the policy that requires the signature for the two images (and leaves every other image as it is) and the registry setting that lets podman fetch signatures from ghcr.io:

```bash
mkdir -p ~/.config/containers/registries.d
curl -fsSL -o cosign.pub "$base/cosign.pub"
curl -fsSL -o ~/.config/containers/policy.json "$base/policy.json"
curl -fsSL -o ~/.config/containers/registries.d/ghcr.yaml "$base/registries.d/ghcr.yaml"
```

The policy names the key as `/home/election/school-election/cosign.pub`; if your user or directory differs, change both `keyPath` lines. `podman image trust show` then lists the two images as signed by that key. From here on, a pull of either image that is not signed with the key, by hand or by the nightly update, fails.

## Secret files

Secrets are files, never environment variables: the app refuses to start when one is set inline. Each container gets only the files it needs, mounted read-only.

```bash
umask 077
mkdir secrets
openssl rand -hex 32 > secrets/session-key
openssl rand -hex 24 > secrets/db-owner-password
openssl rand -hex 24 > secrets/db-runtime-password
nano secrets/entra-client-secret   # paste the client secret's value
chmod 400 secrets/session-key secrets/db-runtime-password secrets/entra-client-secret
chmod 440 secrets/db-owner-password
podman unshare chown 10001:10001 secrets/session-key secrets/db-runtime-password secrets/entra-client-secret
podman unshare chown 10001:70 secrets/db-owner-password
```

The app image runs as uid 10001, the app and the migrator alike. The PostgreSQL image reads the superuser password as its own user, whose group is 70, so that file is also readable by group 70. `podman unshare` is needed because rootless podman maps these ids to the subordinate ids of `election`; afterwards the files can only be changed or removed through `podman unshare` as well.

- `session-key` seals the session cookies, the administrators' and the voters' alike (two cookies, two derived keys). A new key signs everyone out and ends every voting session.
- `db-owner-password` is the password of the PostgreSQL superuser `postgres`, which only the migrator uses. PostgreSQL takes it from the file only when it creates the database on the very first start.
- `db-runtime-password` is the password of the app's role, `school_election_app`. The migrator sets it on every start of the app, so a new password takes effect with the next restart.
- `entra-client-secret` is the client secret from the app registration.

## Configuration

Fill in `.env`:

- `PUBLIC_URL` is the address browsers use, `https://wahl.example.org`, or with a path, `https://www.example.org/wahl` (see below).
- `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID` come from the app registration.
- `TRUST_PROXY` names the addresses whose `X-Forwarded-For` and `X-Forwarded-Proto` the app believes.
- `LOG_LEVEL` is `info`, `warn` or `error`.

The proxy, or the tunnel's end on this host, connects to `127.0.0.1:3000`, but rootless podman forwards that connection into the container from an address on the app's egress network, so the app never sees 127.0.0.1. If `TRUST_PROXY` does not cover that address, the app ignores the forwarded headers and takes every request for one client, so the per-address limits on sign-in apply to everyone at once. Rootless podman takes networks from `10.89.0.0/16` unless configured otherwise, which is the value in `.env.example`. Since the app's port is published on loopback only, nothing but the proxy's connection and other containers on this host arrive from there. If other podman stacks run on the same host, narrow it to the subnet that `podman network inspect school-election-egress` shows after the first start; that subnet stays until the network is removed.

## Under a path of an existing site

The app can run under a path of a site that already exists, `https://www.example.org/wahl`, when no host of its own is at hand. Set `PUBLIC_URL` to that address (its path without a trailing slash) and register the redirect URI `https://www.example.org/wahl/api/auth/callback`. The app serves everything below the path itself, the pages, the API, its files and the cards' addresses included, so the proxy forwards requests for `/wahl` unchanged: the end of [`nginx.example.conf`](nginx.example.conf) has the locations for that site's server block, the same three as on a host of its own with the prefix, and `proxy_pass` without a URI. The health check lives under the path too, `/wahl/api/health`, which the unit and the update script follow.

One thing a shared host costs: the app's defence against cross-site requests trusts its own origin, which is then the whole site, so a weakness in another application on `www.example.org` could reach the election API with a signed-in teacher's session. A host of its own keeps that boundary; where the DNS allows it, prefer one.

## First start

```bash
systemctl --user start school-election.service
curl -fsS http://127.0.0.1:3000/api/health
```

Starting the app's unit pulls both images, starts PostgreSQL and waits until it is ready, runs the migrations, starts the app and waits until its health check passes; the first start takes a minute or two. Then switch the nightly update on:

```bash
systemctl --user enable --now podman-auto-update.timer
```

The health check answers `{"status":"ok","db":"up","busy":false,"version":"v1.0.0","gitSha":"…","tallyVersion":2}` with the release and commit that are running and the version of the counting rules they apply; `busy` is true while a round accepts ballots. When the app does not come up, `journalctl --user -u school-election` names every problem it refused to start with: a missing or unsafe setting, an unreadable secret file, a migration that failed, or a PostgreSQL setting that differs from what the privacy model needs.

Four things only a host can prove; check them once, after the first start:

```bash
podman auto-update --dry-run              # lists both units with "false": nothing newer than what runs
systemctl --user restart school-election.service && journalctl --user -u school-election -n 30
                                          # the migrator's "nothing to apply", then the app
~/school-election/not-busy.sh && echo "would update"   # exits 0 while no round accepts ballots
podman pull docker.io/library/postgres:18-alpine   # another image pulls as before: the policy binds the two of the app alone
podman image trust show                   # the two images of the app: signed by the key, everything else accepted
```

## The proxy and TLS

The app never terminates TLS itself. A reverse proxy does, and reaches the app's `127.0.0.1:3000`:

- on the same machine, directly;
- on another host, through a tunnel from this host to it: an outgoing `autossh -N -R 127.0.0.1:3000:127.0.0.1:3000` to the proxy host, whose web server then forwards to its own `127.0.0.1:3000`, or an `frpc` client to an `frps` there. Either way the app host opens no inbound port and holds no certificate; the tunnel is one more user unit here, and the proxy host's configuration is that host's business.

In both cases the proxy sets `X-Forwarded-For` and `X-Forwarded-Proto`, and the app sees the proxy's connection, or the tunnel's local end, as the client, which is what `TRUST_PROXY` covers above.

The nginx example is the pattern for the proxy. Fetch it on the proxy host, replace `wahl.example.org` with your host name, and enable it:

```bash
tag=v1.0.0   # the release you started from, as above
sudo curl -fsSL -o /etc/nginx/sites-available/school-election "https://raw.githubusercontent.com/cmiicbrg/school-election/$tag/deploy/nginx.example.conf"
sudo nano /etc/nginx/sites-available/school-election
sudo ln -s /etc/nginx/sites-available/school-election /etc/nginx/sites-enabled/school-election
```

The example expects the certificate under `/etc/letsencrypt/live/wahl.example.org/` and answers ACME challenges from `/var/www/certbot`, so certbot's webroot mode issues and renews it. For the first certificate, comment out the port 443 server until certbot has run:

```bash
sudo mkdir -p /var/www/certbot   # certbot refuses a webroot that does not exist
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/certbot -d wahl.example.org --deploy-hook 'nginx -t && systemctl reload nginx'
```

Then restore the port 443 server. certbot keeps the deploy hook for renewals, so nginx picks up each renewed certificate. On an SELinux host, nginx may not connect to the app's port until `sudo setsebool -P httpd_can_network_connect 1` allows it. A proxy that is not nginx does the same four things: TLS, the forwarded headers, the body limit for pictures, and no access log for `/api/voter` and the sign-in callback.

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -fsS https://wahl.example.org/api/health
```

Then sign in at `https://wahl.example.org/api/auth/login`. Afterwards `https://wahl.example.org/api/auth/me` shows the signed-in name, with the role `teacher` for teachers.

nginx only terminates TLS, forwards and logs. Do not add security headers or access rules there: the app sets the headers (CSP, HSTS, Referrer-Policy and the rest) and checks every request itself. The log format leaves out query strings and cookies, `/api/voter` and the plain-HTTP redirects are not logged at all, the error log keeps only critical entries for `/api/voter` and the sign-in callback, and neither request bodies nor responses are ever buffered to disk. Request bodies are limited to 64 KiB, as in the app, except for the upload of a candidate picture, which has its own `location` with 352 KiB. If you keep an older copy of the example, add that `location` block, or picture uploads fail with 413.

## Updates

Updates are automatic. Every release of this repository is tested with the whole suite and the browser journeys before it is tagged, published as `v1.x.y` and moves the `v1` tag of both images. `podman-auto-update.timer` runs nightly: it pulls a newer `v1` where there is one and restarts the unit, which for the app means the migrations first and then the new release; a start that fails is rolled back to the previous image. The drop-in installed above makes the timer skip a night while a round accepts ballots, so no update ever lands on an election day; it runs the night after.

Never restart or reboot by hand while a round is open: voting would stop, and a ballot on its way could fail. The health check's `busy` says whether one is.

To update at once instead of waiting for the night, `podman auto-update`. To see what it would do, `podman auto-update --dry-run`.

A major version is the one update that is done by hand. It comes with a release note that says what to do; for a PostgreSQL major that is a dump and restore of the data volume. Change `v1` to `v2` in both unit files under `~/.config/containers/systemd/`, then `systemctl --user daemon-reload` and `podman auto-update`. If a release note says the unit files themselves changed, fetch them again from that release as in Host above; that is rare.

Migrations only go forward. Going back to an older release works only if it has the same migrations; otherwise restore a backup taken before the update.

## Reboots

With linger enabled, the units are wanted by the user's `default.target` and start at boot, the database first, without anyone logging in. Check it once after the first deployment: reboot the machine, then run the health check above.

## Backups

- Logical dumps only, and without the ballot box: `(umask 077 && podman exec school-election-postgres pg_dump -U postgres -d school_election --format=custom --exclude-table-data=ballot_box > school-election-$(date +%F).dump)`. A dump outlives the election, and ballots must not. It still holds names, addresses, candidate pictures and the audit log, hence the umask: only `election` may read it.
- Never during an election, from opening its first round until the election is final. In that time, also no file-level copy or snapshot of the PostgreSQL volume or the virtual machine: until finalization, whose first step is the clean-up, deleted rows and the write-ahead log in the data files can still link ballots to keys.
- No WAL archiving, no point-in-time recovery, no replication slot and no standby. `archive_mode` is off, `max_replication_slots` and `max_wal_senders` are 0, and the app refuses to start otherwise. Finalizing an election refuses while something still holds its write-ahead log or an older snapshot (a running dump, for instance), and is simply tried again afterwards.

## Logs

- The app logs JSON lines to the journal, `journalctl --user -u school-election`, without request lines, client addresses, query strings or error messages. The migrator's lines are there too, before each start.
- PostgreSQL logs warnings and errors only, never statements or their parameters: `journalctl --user -u school-election-postgres`.
- The proxy logs what its configuration allows; with the nginx example, nothing for `/api/voter` or the plain-HTTP redirects.
