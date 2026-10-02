#!/usr/bin/env bash
# Starts a PostgreSQL container with the server settings the application
# requires at startup (apps/api/lib/db-settings.ts). CI and development use
# this one script, so the settings cannot drift apart; a test checks that
# every required setting appears below.
#
# Usage: scripts/postgres.sh <container-name> <host-port> <owner-password-file>
# Uses docker unless CONTAINER_ENGINE is set (e.g. CONTAINER_ENGINE=podman).
# The server listens on 127.0.0.1 only; the database is school_election and
# the owner is the postgres superuser.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <container-name> <host-port> <owner-password-file>" >&2
  exit 2
fi
name="$1"
port="$2"
engine="${CONTAINER_ENGINE:-docker}"

# The image reads the password file again after dropping to its own user,
# which cannot read a 0600 file owned by the caller. Mount a 0644 copy kept
# in a directory only the caller can enter.
secret_dir="${TMPDIR:-/tmp}/school-election-postgres-${name}"
mkdir -p "$secret_dir"
chmod 700 "$secret_dir"
password_file="$secret_dir/owner-password"
install -m 0644 "$3" "$password_file"
image='docker.io/library/postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'

settings=(
  -c track_commit_timestamp=off
  -c archive_mode=off
  -c wal_recycle=off
  -c wal_keep_size=0
  -c summarize_wal=off
  -c log_statement=none
  -c log_error_verbosity=terse
  -c log_min_error_statement=panic
  -c log_parameter_max_length=0
  -c log_parameter_max_length_on_error=0
  -c log_min_duration_statement=-1
  -c log_min_duration_sample=-1
  -c log_transaction_sample_rate=0
  -c log_lock_waits=off
)

"$engine" run -d --name "$name" \
  -p "127.0.0.1:${port}:5432" \
  -e POSTGRES_DB=school_election \
  -e POSTGRES_PASSWORD_FILE=/run/secrets/owner-password \
  -v "${password_file}:/run/secrets/owner-password:ro" \
  "$image" "${settings[@]}" >/dev/null

# Probe TCP, not the socket: on first start the image runs a temporary,
# socket-only server for initialisation, and only the final server, started
# after the database exists, listens on TCP.
for _ in $(seq 1 60); do
  if "$engine" exec "$name" pg_isready -q -h 127.0.0.1 -p 5432 -U postgres -d school_election; then
    echo "PostgreSQL ready on 127.0.0.1:${port}"
    exit 0
  fi
  sleep 1
done
"$engine" logs "$name" >&2
echo "PostgreSQL did not become ready within 60s" >&2
exit 1
