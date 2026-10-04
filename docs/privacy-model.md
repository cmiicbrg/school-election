# The privacy model

What this system promises about a ballot, what PostgreSQL records about one while it is cast, what removes each trace, what the tests prove, and what remains. The election model itself is in [`design.md`](design.md); this document is about the database underneath it.

## The claim

After an election, neither the database, nor an export, a backup or the application's ordinary logs say which ballots one voting key cast, or which ballots in different contests were cast with the same key. A ballot (`ballot`) carries its ballot box, its kind and its ranking, and nothing else: no key, no entitlement, no session, no person, no time, no request. Nothing references a ballot. The privacy tables (`ballot_box`, `ballot`, `credential`, `credential_entitlement`) have random ids only, no sequence, no timestamp and no ordered id, which the privacy regression checks against the catalog.

Columns are the easy half. The other half is what PostgreSQL itself records about every row, and the rest of this document is about that.

## What a vote leaves behind

A vote is one transaction: it uses the key's entitlement up (`credential_entitlement.consumed`) and stages the ballot (`ballot_box`). PostgreSQL records, for every row version it writes:

- **The transaction id** (`xmin`, and `xmax` on the version it replaces or deletes). Both rows of a vote carry the same one, so a key's three ballots carry three ids that pair with its three entitlements. Any snapshot of the pages, or any dump that includes system columns, links them.
- **The physical position** (`ctid`). Rows lie on disk, and in a dump, in the order they were written, which is the order the votes came in; an entitlement used up gets a new version at that moment. Positions alone, with the application's own request log, could pair a ballot with the moment a key was redeemed.
- **The write-ahead log.** Every change is logged for crash recovery before it reaches the data files: the staged ballot with its content and the entitlement's new version, in the same records of the same transaction. A segment of that log lives on disk until a checkpoint no longer needs it, or, with the default settings, for much longer: segments are renamed and reused, archived, or kept for a standby.
- **Dead row versions.** A row that was deleted or replaced stays in its page, with its content and its transaction ids, until a vacuum removes it; the pages a vacuum compacts are rewritten in place.
- **Commit timestamps**, if `track_commit_timestamp` is on: when each transaction committed, which orders the ballots.
- **Statement logs**, if PostgreSQL logs statements, their parameters or their duration: every vote with its key.

The application logs nothing of a vote, and the audit log records administrators' actions only, never a voter's (`design.md`, Audit log).

## What removes each trace

**The write-only ballot box.** While a round is open, the runtime role can insert into `ballot_box` and can neither read, change nor remove a staged ballot, so no code path can show a ballot or a result before the round is sealed. A test of a prepared election is the one exception, whose staged ballots are read and removed only by the test mode's `SECURITY DEFINER` functions and never reach a seal.

**The seal** (`seal_round`, migration `0009`), which is the only way a round closes. In one transaction it moves the round's staged ballots into `ballot` under fresh random ids, in id order, and writes the round's entitlements again, unchanged, in credential order. Every live row of a sealed round carries the seal's one transaction id, and the live rows no longer lie in the order the votes used them up. The design notes (Ballot box and seal) explain why the seal takes its locks in the order it does.

**The clean-up at finalization** (`apps/api/lib/cleanup.ts`, migration `0014`), the first step of ending an election, once every round is sealed. It rewrites `ballot_box` and `credential_entitlement` without their dead row versions (`VACUUM FULL`, which the runtime role may run on exactly these two tables), notes the write-ahead log position after the rewrite, then switches the log and checkpoints, twice (`flush_wal`, an owner's function), so that every segment written before the rewrite is unlinked, and refuses to go on if any such segment is still on disk. Before the rewrite it waits for every session, prepared transaction or replication slot whose snapshot is older than the election's seals (`cleanup_blockers`, an owner's function, since the runtime role cannot see other sessions' snapshots): a vacuum keeps a dead row that such a snapshot could still see, so a rewrite under one would prove nothing. Only after the clean-up does the election become final, and nothing of it changes afterwards. `ballot` is not rewritten: the seal only inserts there, so it has no dead rows of the votes.

**The settings the server requires at startup** (`apps/api/lib/db-settings.ts`), with which the server refuses to start otherwise: `wal_recycle=off` (segments are unlinked, never renamed and reused with old content inside), `wal_keep_size=0`, `summarize_wal=off`, `archive_mode=off`, `max_replication_slots=0` and `max_wal_senders=0` (no slot keeps the log and no standby receives it); `track_commit_timestamp=off`; and the logging settings that keep statements, parameters and durations out of the server log. Development, CI and the deployment example set exactly these flags, and a test keeps the three in step.

**The roles.** The server connects as a role that holds exactly what `apps/api/lib/runtime-privileges.ts` lists, re-applied by every migration run. It never reads a staged ballot, never deletes a sealed one, and runs the elevated steps only through the owner's functions, each of which does one fixed thing.

## What the tests prove

The privacy regression (`apps/api/test/helpers/privacy.ts`) runs wherever the path from a key to a sealed ballot is touched: one key entitled to three contests votes in all three among fifty other voters, interleaved, through plain SQL, through `castBallot`, through the close route and through the voter routes, and through the runoff with its fresh keys. After the seal it reads what only the owner sees:

- the privacy tables have exactly the listed columns, and no timestamp, sequence or ordered id;
- within every page the ballots lie in id order, and the entitlements no longer lie in the order they were used up;
- every ballot and every entitlement of the round carries the seal's transaction id and none of the votes';
- the keys' rows were never touched, the staging table is empty, and the tracked key's ballots are in their boxes by content among the others.

Before the seal, the same test shows the link the seal removes.

The clean-up test (`apps/api/test/db/cleanup.test.ts`) reads further, with `pageinspect` and `pg_walinspect` as the owner, right after the seal: every tuple of every page of the three tables, the dead ones included, and every record of every write-ahead segment on disk. The votes' transaction ids are there, in the dead rows and in the log; after the clean-up they are nowhere, the seal's order is kept and the results are unchanged. A `REPEATABLE READ` snapshot opened before the seal counts as a blocker, a rewrite under it keeps the dead rows, and the clean-up waits for it and then refuses; a snapshot opened after the seal counts for nothing. CI runs all of it against PostgreSQL with the production flags, and afterwards searches the PostgreSQL log for values the regression writes.

## What remains

- **Deleted files until they are overwritten.** The old relation files the rewrite unlinks and the write-ahead segments the checkpoint removes stay recoverable by disk forensics until the file system reuses the blocks, on a solid-state disk for as long as its wear levelling keeps them. An operator with the disk can read them; the model does not try to prevent that.
- **Copies made in the window.** A backup, a dump with system columns, a snapshot of the volume or of the virtual machine taken between the opening of the first round and the end of finalization holds the pre-seal pages and the write-ahead log, with everything above in them. The operator guide keeps every backup and snapshot out of that window and allows logical dumps without the ballot box only; nothing in the application can undo a copy that was made.
- **The server while voting runs.** An operator with root on the running server, or a superuser on the database, can read the staged ballots and the entitlements as they are written. The threat model assumes the live server runs the deployed software unmodified and the database is not read by hand while a round is open.
- **Transaction ids without rows.** The commit log (`pg_xact`) and the multitransaction files keep which transaction ids committed and which ones locked the election's row together, but after the clean-up no row and no log record maps an id to a ballot or a key.
- **Memory and temporary files.** What the server held in memory while voting, and a sort that spilled to disk, are outside what the database records; at school scale a seal sorts in memory.
- **A botched clean-up** is reported, never assumed: an election is final only after the write-ahead check passed, and a clean-up that was blocked or found segments retained answers with the reason and is tried again.
