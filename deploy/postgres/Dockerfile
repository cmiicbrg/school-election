# PostgreSQL for school-election, published next to the app as
# ghcr.io/cmiicbrg/school-election-postgres under the same tags: the
# upstream image, pinned, with every setting the app checks at startup
# (apps/api/lib/db-settings.ts) as its command, so an image without them
# cannot exist and a deployment carries none. Dependabot bumps the pin;
# scripts/postgres.sh starts the same pinned image for development and
# CI, and apps/api/test/deploy-flags.test.ts keeps the three lists in
# step. A PostgreSQL major changes only with the app's major line: the
# data directory needs a dump and restore (deploy/README.md). No USER
# instruction: the upstream entrypoint starts as root, takes ownership of
# a fresh data directory, and steps down to the postgres user itself.
# No `# syntax=` line, as in the app's Dockerfile: the pinned BuildKit's
# built-in frontend reads this file.

FROM docker.io/library/postgres:18.6-alpine@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5

CMD ["postgres", \
  "-c", "track_commit_timestamp=off", \
  "-c", "archive_mode=off", \
  "-c", "wal_recycle=off", \
  "-c", "wal_keep_size=0", \
  "-c", "summarize_wal=off", \
  "-c", "max_replication_slots=0", \
  "-c", "max_wal_senders=0", \
  "-c", "log_statement=none", \
  "-c", "log_error_verbosity=terse", \
  "-c", "log_min_error_statement=panic", \
  "-c", "log_parameter_max_length=0", \
  "-c", "log_parameter_max_length_on_error=0", \
  "-c", "log_min_duration_statement=-1", \
  "-c", "log_min_duration_sample=-1", \
  "-c", "log_transaction_sample_rate=0", \
  "-c", "log_lock_waits=off", \
  "-c", "log_duration=off", \
  "-c", "debug_print_parse=off", \
  "-c", "debug_print_rewritten=off", \
  "-c", "debug_print_plan=off", \
  "-c", "log_statement_stats=off", \
  "-c", "log_parser_stats=off", \
  "-c", "log_planner_stats=off", \
  "-c", "log_executor_stats=off", \
  "-c", "log_min_messages=warning", \
  "-c", "log_destination=stderr"]
