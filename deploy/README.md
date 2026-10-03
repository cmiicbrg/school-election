# Deploying school-election

One virtual machine runs everything. Rootless podman runs PostgreSQL and the app from [`compose.example.yml`](compose.example.yml); nginx on the host terminates TLS and forwards to the app with [`nginx.example.conf`](nginx.example.conf). The examples use `wahl.example.org` for the site, `election` for the user that runs the stack and `~/school-election` for its directory; replace them with your own.

- `postgres` is reachable only from the stack's internal network, which has no route off the host: no published port, data in a named volume. It starts with exactly the settings the app checks at startup.
- `app` runs the published image, pinned by tag and digest, read-only, without capabilities, listening on `127.0.0.1:3000` only.
- `migrate` is a one-shot service: it applies pending migrations and sets the password of the app's database role.

## Entra ID app registration

Teachers and witnesses sign in with their school Microsoft accounts. In the Microsoft Entra admin center, under App registrations:

1. Register a new application for this tenant only ("Accounts in this organizational directory only") with the redirect URI `https://wahl.example.org/api/auth/callback`, platform Web. The redirect URI is always `PUBLIC_ORIGIN` followed by `/api/auth/callback`.
2. Its overview shows the Directory (tenant) ID and the Application (client) ID: `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID` in `.env`.
3. Under Certificates & secrets, create a client secret and keep its value (not its ID) for `secrets/entra-client-secret` below. Note the expiry date: after it, sign-in fails until a new secret is in the file and the app has been restarted.
4. Under App roles, create a role for users and groups with the value `teacher`. Only this value counts; the app ignores any other role. Under Enterprise applications, open the same application and assign the teacher role to the teachers under Users and groups. Teachers may create elections; everyone else sees only the elections they are a member of.
5. Witnesses are students and sign in without a role. If "Assignment required?" is set to Yes in the enterprise application's properties, they need an assignment too, or they cannot sign in.

No optional claims are needed. The app asks for `openid email profile` and takes the address from the `email` claim, or from `preferred_username` when there is none. If users in the tenant may not consent to applications themselves, add the delegated Microsoft Graph permissions `openid`, `email` and `profile` under API permissions and grant admin consent.

Development uses a separate registration in the school's tenant, with its own secret and the redirect URI `http://localhost:5173/api/auth/callback` (see `apps/api/.env.example`). Never add a localhost redirect URI to the production registration, and never use its secret anywhere else.

## Host

The host needs rootless podman with `podman compose` (which runs docker-compose or podman-compose, whichever is installed), nginx 1.25.1 or newer (older versions need the change noted in the example) and certbot. Create the user `election` without sudo rights, then let its containers run without a login session and start at boot:

```bash
sudo loginctl enable-linger election
```

Every other command in this guide except the nginx and certbot ones runs as `election`, in its directory `~/school-election` and in a real login session (ssh, or `sudo machinectl shell election@`); `sudo -u` does not provide the user session that `systemctl --user` and rootless podman need.

```bash
systemctl --user enable podman-restart.service
mkdir ~/school-election && cd ~/school-election
tag=v1.0.0   # the release to deploy
curl -fsSL -o compose.yml "https://raw.githubusercontent.com/cmiicbrg/school-election/$tag/deploy/compose.example.yml"
curl -fsSL -o .env "https://raw.githubusercontent.com/cmiicbrg/school-election/$tag/deploy/.env.example"
chmod 600 .env
```

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

- `session-key` seals the session cookies. A new key signs everyone out.
- `db-owner-password` is the password of the PostgreSQL superuser `postgres`, which only the migrator uses. PostgreSQL takes it from the file only when it creates the database on the very first start.
- `db-runtime-password` is the password of the app's role, `school_election_app`. The migrator sets it on every run, so a new password takes effect after the next migration run and an app restart.
- `entra-client-secret` is the client secret from the app registration.

## Configuration

Fill in `.env`:

- `IMAGE` is the release, pinned by tag and digest. The summary of the Publish Image workflow run for each release tag prints the exact value.
- `PUBLIC_ORIGIN` is the origin browsers use, `https://wahl.example.org`.
- `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID` come from the app registration.
- `TRUST_PROXY` names the addresses whose `X-Forwarded-For` and `X-Forwarded-Proto` the app believes.

nginx connects to `127.0.0.1:3000`, but rootless podman forwards that connection into the container from an address on the app's compose network, so the app never sees 127.0.0.1. If `TRUST_PROXY` does not cover that address, the app ignores the forwarded headers and takes every request for one client, so the per-address limits on sign-in apply to everyone at once. Rootless podman takes compose networks from `10.89.0.0/16` unless configured otherwise, which is the value in `.env.example`. Since the app's port is published on loopback only, nothing but nginx and other containers on this host connect from there. If other podman stacks run on the same host, narrow it to the subnet that `podman network inspect school-election_egress` shows after the first start; that subnet stays until the network is removed, for instance by `podman compose down`.

## First start

```bash
podman compose pull
podman compose --profile migrate run --rm migrate
podman compose up -d
curl -fsS http://127.0.0.1:3000/api/health
```

The health check answers `{"status":"ok","db":"up","version":"v1.0.0","gitSha":"…"}` with the release and commit that are running. On its very first start PostgreSQL creates the database before it accepts connections; if the migration reports that it cannot connect, run it again. When the app does not come up, `podman compose logs app` names every problem it refused to start with: a missing or unsafe setting, an unreadable secret file, or a PostgreSQL setting that differs from what the privacy model needs.

## nginx and TLS

Fetch the nginx example of the same release, replace `wahl.example.org` in it with your host name, and enable it:

```bash
sudo curl -fsSL -o /etc/nginx/sites-available/school-election "https://raw.githubusercontent.com/cmiicbrg/school-election/v1.0.0/deploy/nginx.example.conf"
sudo nano /etc/nginx/sites-available/school-election
sudo ln -s /etc/nginx/sites-available/school-election /etc/nginx/sites-enabled/school-election
```

The example expects the certificate under `/etc/letsencrypt/live/wahl.example.org/` and answers ACME challenges from `/var/www/certbot`, so certbot's webroot mode issues and renews it. For the first certificate, comment out the port 443 server until certbot has run:

```bash
sudo mkdir -p /var/www/certbot   # certbot refuses a webroot that does not exist
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/certbot -d wahl.example.org --deploy-hook 'nginx -t && systemctl reload nginx'
```

Then restore the port 443 server. certbot keeps the deploy hook for renewals, so nginx picks up each renewed certificate. On an SELinux host, nginx may not connect to the app's port until `sudo setsebool -P httpd_can_network_connect 1` allows it.

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -fsS https://wahl.example.org/api/health
```

Then sign in at `https://wahl.example.org/api/auth/login`. Afterwards `https://wahl.example.org/api/auth/me` shows the signed-in name, with the role `teacher` for teachers.

nginx only terminates TLS, forwards and logs. Do not add security headers or access rules there: the app sets the headers (CSP, HSTS, Referrer-Policy and the rest) and checks every request itself. The log format leaves out query strings and cookies, `/api/voter` and the plain-HTTP redirects are not logged at all, the error log keeps only critical entries for `/api/voter` and the sign-in callback, and neither request bodies nor responses are ever buffered to disk.

## Updates

Never redeploy, restart or reboot while a round is open: voting would stop, and a ballot on its way could fail.

To update, set `IMAGE` in `.env` to the new release, compare `compose.yml` with the new release's `deploy/compose.example.yml`, then:

```bash
podman compose pull
podman compose --profile migrate run --rm migrate
podman compose up -d
curl -fsS http://127.0.0.1:3000/api/health   # reports the new version
```

Migrations only go forward. Going back to an older release works only if it has the same migrations; otherwise restore a backup taken before the update.

## Reboots

With linger enabled, `podman-restart.service` starts every container with `restart: always` at boot, so the stack comes back without anyone logging in. Check it once after the first deployment: reboot the machine, then run the health check above.

## Backups

- Logical dumps only, and without the ballot box: `(umask 077 && podman compose exec -T postgres pg_dump -U postgres -d school_election --format=custom --exclude-table-data=ballot_box > school-election-$(date +%F).dump)`. A dump outlives the election, and ballots must not. It still holds names, addresses and the audit log, hence the umask: only `election` may read it.
- Never during an election, from opening its first round until the clean-up after its export has finished. In that time, also no file-level copy or snapshot of the PostgreSQL volume or the virtual machine: until the clean-up, deleted rows and the write-ahead log in the data files can still link ballots to keys.
- No WAL archiving and no point-in-time recovery. `archive_mode` is off, and the app refuses to start otherwise.

## Logs

- The app logs JSON lines to `podman compose logs app`, without request lines, client addresses, query strings or error messages.
- PostgreSQL logs warnings and errors only, never statements or their parameters.
- nginx logs what its log format allows, and nothing for `/api/voter` or the plain-HTTP redirects.
