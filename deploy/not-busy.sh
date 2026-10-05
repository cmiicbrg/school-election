#!/bin/sh
# Whether the app may be updated or restarted now: exits 0 unless a round
# accepts ballots, which the app's health check reports as "busy": true.
# podman-auto-update.service runs this as its ExecCondition
# (deploy/systemd/podman-auto-update.service.d/busy.conf), so the nightly
# update skips an election day without failing. An app that does not
# answer blocks nothing: nothing is busy then. The base path comes from
# PUBLIC_URL in the app's .env.
set -eu

env_file="${1:-$HOME/school-election/.env}"
url="$(sed -n 's/^PUBLIC_URL=//p' "$env_file" | tr -d '"'"'"'"' | tail -n 1)"
path="$(printf '%s' "$url" | sed -E 's#^[A-Za-z][A-Za-z0-9+.-]*://[^/]*##; s#/$##')"

if curl -fsS --max-time 5 "http://127.0.0.1:3000${path}/api/health" | grep -q '"busy":true'; then
  echo "school-election: a round accepts ballots, not updating now"
  exit 1
fi
