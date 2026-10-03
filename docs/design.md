# Design notes

A living record of the decisions behind the election model. Update it in the same pull request that changes the behaviour it describes.

## Rulesets and slots

A ruleset is a fixed, ordered list of slots. Each slot is one function a voter assigns a candidate to, and the statutory points that assignment carries. Function and points are two views of the same slot, so the ballot can show both side by side.

| Ruleset | Slots (points, function) | Used for |
| --- | --- | --- |
| `at-school-speaker-v1` | 6 Schulsprecher/in, 5 1. Stellvertretung, 4 2. Stellvertretung, 3 1. SGA-Stellvertretung, 2 2. SGA-Stellvertretung, 1 3. SGA-Stellvertretung | Schulsprecherwahl |
| `at-representative-v1` | 2 Vertreter/in, 1 Stellvertreter/in | Klassen- und Abteilungssprecherwahl |
| `single-choice-v1` | 1 Stimme | Runoff rounds, anonymous single-choice polls |

The Austrian tables follow the regulation on the election of school representatives (RIS Gesetzesnummer 10009897). Rulesets are constant data in `packages/election-core/src/rulesets.ts`. No configuration, request or import can supply or change points.

Ruleset ids carry a version. A ruleset is never edited in place; a change gets a new id, so a result stored under an old id can always be recomputed with the rules it was counted under.

### Active slots

A contest with `n` candidates uses the first `min(n, slots)` slots of its ruleset, and only those. A four-candidate Schulsprecherwahl has the slots 6, 5, 4 and 3. The 2- and 1-point slots do not exist on that ballot, because no candidate would be left to fill them.

## Ballot representation

A ballot takes one of two forms:

- **Ranking** (`{ kind: 'ranking', ranking, confirmInvalid? }`): the slots as the voter left them. Position 0 is the highest slot, position 1 the next, and so on; each entry is a candidate id, or `null` for a slot left empty. The slot, and with it the points, follows from the position alone; points are never submitted and never stored.
- **Nein** (`{ kind: 'no' }`): only in a contest with a single candidate, so that voters can vote against them. A valid ballot that ranks nobody.

The ranking form cannot express two candidates in one slot. Map- or object-shaped rankings are rejected rather than interpreted.

A ranking is refused outright when it cannot come from a correct client:

- it is not an array, has holes, or holds an entry that is neither a string nor `null` (`malformed`);
- it is longer than the number of active slots (`inactive-slot`);
- it names a candidate who is not in the contest (`unknown-candidate`), or the same candidate twice (`duplicate-candidate`).

Otherwise it is a **valid vote** when every active slot holds a candidate, and an **invalid vote** when one or more slots are empty. An invalid vote is cast only with `confirmInvalid: true`; without it the ballot is refused as `incomplete` with the number of filled slots, so the client has to show the voter what would be submitted and ask first.

"Nein" in a contest with more than one candidate is `no-not-offered`; any other shape is `malformed`.

Validation errors carry positions and counts only, never candidate ids, so a rejected ballot can be logged or answered without revealing its content.

### Completeness

A valid ranking fills every active slot. With `n` ≤ 6 candidates on a Schulsprecher ballot every candidate appears exactly once; with more, exactly six distinct candidates are ranked and the rest receive zero points from that ballot.

Completeness is a validity rule, not a convenience. The lower slots decide the deputies, the SGA substitutes and point-based runoff tiebreaks. A voter who could award the top points and withhold the rest could steer those positions strategically. A ballot with empty slots is therefore invalid as a whole: it gives no candidate any points, so withholding the lower slots cannot shift anything.

The regulation has voters enter the names of six (or two) candidates (§ 11 Abs. 2 and 3) and counts a vote as valid "wenn der Wählerwille aus dem Stimmzettel eindeutig hervorgeht" (§ 11 Abs. 5). It does not say how to count a ballot with some slots empty. Treating it as invalid is this project's reading of those rules, decided for the reason above; it is not a sentence of the regulation.

## Why points are never rescaled

For `n` ≤ 6 candidates the active statutory scale is `6, 5, …, 7−n`. A rescaled scale `n, n−1, …, 1` may look more natural, and on complete ballots it gives the same outcome: every candidate appears once on every ballot, so each candidate's statutory total over `V` complete rankings is

```text
statutoryTotal = rescaledTotal + V · (6 − n)
```

The constant is the same for every candidate, so ordering, ties, deputy order and every comparison of totals are identical. The property tests in `packages/election-core/test/statistics.test.ts` check this exhaustively for small cases and on seeded random ballot sets.

The equivalence depends on complete ballots; with optional rankings the offset would differ between candidates. The code still uses the statutory points everywhere, because they match the regulation and the audit output one to one, keep a single counting algorithm without special cases, and preserve the link between points and function.

## Invalid votes and "Nein"

Leaving one or all slots empty is the voter's choice, as on paper; an all-empty ballot is "weiß wählen". Such a ballot is an invalid vote, possible in every contest, whatever the number of candidates. It uses up the voter's entitlement for that contest and is counted and reported on its own, since the count distinguishes valid from invalid votes (§ 12 Abs. 1 of the regulation). It gives nobody points or a first place and is not part of the majority base, which is the number of valid ballots. Only its kind is stored, not which slots were filled: it counts only as invalid.

An invalid vote is never cast by accident. Before submitting, the voter sees for each contest what would be submitted and whether it is valid, and can still correct it; an invalid vote needs an explicit confirmation, and the API refuses an incomplete ballot that does not carry it.

"Nein" exists only in a contest with a single candidate. There every ranking places the candidate first, so without "Nein" nobody could vote against them. "Ja" is the ranking with that one candidate; "Ja" and "Nein" are both valid ballots. No other contest has a "Nein" option.

## Determinism

`election-core` is pure: no I/O, no imports from outside its `src` directory, and no access to the clock, randomness or the runtime environment (ESLint enforces all of them). The same configuration and the same ballots always produce the same figures, in the API, in the browser and in an offline verifier. `TALLY_VERSION` changes with any change to counting semantics and is stored with every result.

Counting arithmetic is integer-only, and per-candidate output follows the contest's candidate order, so it never depends on the order in which ballots arrive.

## Results

Results are computed from the contest configuration and the cast ballots alone (`packages/election-core/src/result.ts`). Every figure comes from `computeStatistics`, so a result is the same for every order of the ballots, and every decision is an explicit comparison of counts. A ballot that was not validated for the contest is a hard error, never skipped.

The **first round** of a ranked contest (`firstRoundResult`) ends in one of four kinds:

- `elected`: a candidate is first on more than half of the valid ballots, checked as `2 × firstPlaces > validBallots`. The result also carries the derived positions as far as the first round decides them.
- `runoff-required`: nobody has that majority; the result names the two runoff candidates.
- `lot-required`: runoff entry is tied on first places and on points. The lot request names the tied set, how many of them enter and who entered without the lot.
- `committee-decision`: zero valid ballots, or a single candidate without "Ja" on more than half of the valid ballots. The software names no winner, no lot and no positions.

Runoff selection fills the two places by first places. When a group of candidates with equal first places no longer fits into the places left, only that group is compared on first-round points, and a group still equal on points goes to the lot. More first places therefore always beat more points.

A **runoff** or an anonymous single-choice poll (`runoffResult`) ends `elected` (more valid votes; in a poll, the most), `tie` (equal votes at the top: no winner and no lot, settled manually) or `committee-decision` (zero valid ballots, or a poll's single option without "Ja" on more than half of the valid ballots). A runoff always has exactly two candidates; a poll with a single option follows the single-candidate rule. A runoff result names the first-round contest it decides, and a poll names none, so neither a poll nor the runoff of another contest with the same two candidates can be applied as a contest's runoff.

### Derived positions

The ruleset's remaining functions, in order, go to the other candidates by first-round points, without the principal: two Schulsprecher deputies and three SGA substitutes, or the one deputy of a class or department representative. Runoff votes never enter; the runoff only decides whose points are left out, so the runoff loser is not automatically a deputy. Candidates with equal points who would hold different positions, or compete for the last one, form one lot request for those positions; a tie below the last position needs none. Positions with no candidate left stay vacant.

### Lots and the final outcome

`resolve(firstRound, runoff, decisions)` combines the stored round results with the recorded lot outcomes. It returns `final` with every position, or the state still open: `lot-required`, `runoff-required`, `tie` or `committee-decision`.

The election officials draw a lot, and an authorised user records its outcome as a decision: the lot's id and the drawn order of exactly its tied set. A decision for a lot that is not required, a second decision for the same lot, or an order that is not exactly the tied set is refused with a typed error. The software never draws and never carries one draw over to another lot: candidates tied for runoff entry and later again for a deputy position face two lots. `resolve` never changes its inputs, so the first-round statistics stay exactly as counted.

### Trace

Every result carries a trace: language-neutral steps with their numbers, which the web app renders in German for witnesses and which goes into the export.

| Step | Content |
| --- | --- |
| `count` | Ballots cast, valid ballots, "Nein" votes and invalid votes of one contest; starts each round |
| `majority` | The first places needed (more than half of the valid ballots) and who reached them, if anyone |
| `compare` | The places to fill, the candidates with their first places, points or votes, who advances and who is tied at the boundary |
| `runoff` | The runoff pair |
| `positions` | Whose points are left out, and the first-round points of everyone else |
| `lot-required`, `lot-applied` | A lot with its tied set, and the recorded order once it is applied |
| `committee-decision` | Why the school committee decides |

For the worked example (Alice 41 first places, Bob and Carol 32 each, Bob 287 points, Carol 271) the trace reads: the count; 53 first places needed, nobody has them; two places by first places, Alice advances, Bob and Carol are tied; one place by points, Bob 287 against Carol 271, Bob advances; the runoff Alice against Bob.

## Lifecycle

An election and its rounds follow one state machine (`packages/election-core/src/lifecycle.ts`), so whether something may happen now is decided in one place rather than by flags spread over the code. The API reads the stored states, asks the lifecycle, and stores the next state in the same transaction as the change.

```text
election  draft ⇄ prepared → active → final
round     planned → open → closed
```

- **draft**: the structure (contests, voter groups and their mapping, each contest's ruleset) can change.
- **prepared**: the structure is fixed and keys can be issued. Unprepare goes back to draft; it is only possible before any round has opened, because prepared always means that none has.
- **active**: the regular round has opened. The runoff round exists only once it is activated, which opens it, after the regular round has closed; runoff keys can be printed in advance and stay unusable until then.
- **final**: no round is open, and nothing changes any more.

A closed round never reopens. A state transition and every guard return either an allowed verdict or a typed refusal (`election-final`, `not-draft`, `not-prepared`, `voting-started`, `round-planned`, `round-open`, `round-closed`, `no-runoff`, `runoff-activated`); an impossible combination of states is a programming error.

| Change | Allowed |
| --- | --- |
| Structure | in a draft |
| Candidates, title and description | until the regular round opens, so a misspelled name never forces a return to draft |
| Witnesses and co-admins | until the election is final |
| Issuing, topping up or replacing a batch of keys | once prepared, until the batch's round opens: regular keys before the regular round, runoff keys until the runoff is activated, also while round 1 is open or closed |
| Casting a ballot | while its round is open |
| A round's result | once the round has closed, for every role; never while it is open |
| Activating the runoff | once, after the regular round has closed |
| Recording a lot, finalizing | after the regular round has closed, while no round is open |

Whether a result actually requires a runoff or a lot is decided by the result (see above), not by the lifecycle.

The database keeps the same windows (migration `0007`): triggers refuse a change to contests, voter groups or their mapping outside a draft, to candidates, title or description once voting has started, and any change to a final election, and they let an election move only along the arrows above, back to draft only while no round has opened. A trigger reads the election's state with a share lock on its row, so a change of state and a configuration change wait for each other instead of passing each other.

## Access to an election

Teachers and witnesses sign in with Entra ID. The global teacher role only lets a person create an election; what anyone may do with an election comes from their membership in it (`apps/api/lib/permissions.ts`):

| Role | May |
| --- | --- |
| Owner, the teacher who created it | everything |
| Co-admin (`admin`) | everything but managing members and finalizing |
| Witness | read the election, its members and its audit log, and results once their round has closed |

Every route under `/api/elections/:id` starts with the same guard (`apps/api/lib/election-access.ts`), before the request body is read: a session (401), then membership, looked up on every request (404), then the role (403), then the lifecycle (409, with the lifecycle's refusal as the error code, such as `election_final`). An election the caller is not a member of answers exactly like one that does not exist, so guessing ids reveals nothing, and a removed member loses access with their next request. The app refuses to start if a route under `/api/elections/` does not begin with the guard, and a path under `/api/elections/` that only some other route would match, through a parameter or a wildcard, is answered as not found. A change takes the election's lock and checks access again inside its transaction, so a removal or a state change that happens in between stops it.

Co-admins and witnesses are invited by their school e-mail address. A pending invitation grants nothing. When someone signs in, every pending invitation whose address matches theirs (the ID token's `email`, or `preferred_username` without one), ignoring case, is bound to their Entra identity in the same transaction that records the sign-in, with an audit event whose actor is the invited person. Only people of the configured tenant are matched, and an invitation is bound once: the database refuses to change it afterwards, so an address that is later given to someone else does not move it. Invitations in a final election, or to someone who is already a member, stay pending. Someone who is signed in already when they are invited sees the election after their next sign-in, so they have to sign out and in again. The address stays with the member, so the member list and the audit log show who was invited.

## Election configuration

An election consists of contests, their candidates and voter groups. Each contest elects one office, or is one question of a poll, under a fixed ruleset that is chosen when the contest is created and can change only in a draft. A voter group (a class or a department) is the unit keys are issued for; it is mapped to the contests its voters vote in, so one key can cover the Schulsprecherwahl, the department's and the class's own contest at once. Every row carries its election, and the links between them are foreign keys on the election as well, so a mapping, a candidate or a ballot box never joins two elections.

Each kind of thing is edited through its own routes (`apps/api/routes/configuration.ts`): the election's title and description, contests, candidates, voter groups and a voter group's contests. A picture is a candidate's too (see below). Each change holds the election's lock and writes its audit event in the same transaction, naming the row by its id together with the values it set, so the log stays readable after a later rename; a change that changes nothing writes nothing. `GET /api/elections/:id/configuration` returns the whole configuration to every member, read in one snapshot.

A preset is only a template: it gives a new election its first contest. Schulsprecherwahl starts with Schulsprecher/in (`at-school-speaker-v1`), Abteilungs- and Klassensprecherwahl with one contest under `at-representative-v1`, and an anonyme Abstimmung with one under `single-choice-v1`, whose candidates are the options. After that the election is configured like any other, so a Schulsprecherwahl can gain department and class contests.

Names and titles are stored cleaned: Unicode NFC, trimmed, with every run of white space inside them as one space. Within an election, two contest titles or two voter group names that compare equal ignoring case are refused, as are two candidates of one contest whose names do.

### Candidate order

Candidates are listed alphabetically by surname, then by given name, in German collation (ICU, `de-AT`, case-insensitive but not accent-insensitive): the order in which the regulation lists them on the ballot (§ 10 Abs. 3). The API computes it in one place (`apps/api/lib/names.ts`) and returns candidates in it everywhere, so the setup screens, the ballot and an export never sort on their own. Two candidates of one contest whose names compare equal are refused rather than put in some order by a tiebreak: "Anna Müller" and "anna MÜLLER" cannot stand side by side, "Anna Müller" and "Anna Muller" can. The order never depends on when a candidate was entered, so a correction or a late addition simply takes its alphabetical place. A poll's options are listed the same way, by their text. Contests are listed by title and voter groups by name, with numbers compared as numbers (2A before 10A).

### Preparing

Preparing fixes the structure and shows what will be printed (`apps/api/lib/prepare.ts`). The summary lists each voter group with the contests it votes in, and each contest with its number of candidates and active slots. It is refused, with the reasons, while there is no contest or voter group, a contest has no candidates or no voter group votes in it, or a voter group votes in nothing. It warns, without refusing, when there is no co-admin who has signed in, fewer than two witnesses who have, or an invitation still pending. `GET /api/elections/:id/preparation` shows all three before and after preparing.

Preparing moves the election to prepared and creates its regular round, planned, with one ballot box (`round_contest`) per contest. Unpreparing goes back to draft, only before any round has opened; the round and its ballot boxes stay, a contest removed in the draft takes its own ballot box with it, and preparing again adds the boxes of contests created since. Candidates, title and description can still be corrected while prepared, without going back to draft. Both steps are audited, preparing with the numbers of contests, voter groups and candidates.

### Candidate pictures

A teacher drops, pastes or picks any photo the browser can open, at any size, and never edits it with other software. The browser prepares it (`apps/web/src/lib/picture.ts`, with the reusable drop component `CandidatePicture.vue`): it decodes the photo upright by its Exif orientation, scales it with pica to fit 480 × 480 without cropping, puts it on white, and encodes it as WebP, or as JPEG where the browser has no WebP encoder, lowering the quality until it fits the upload limit. A format the browser cannot open, such as HEIC outside Safari, gets a message asking for a JPEG or PNG photo. Lists and the ballot show a picture in a fixed square frame with `object-fit: cover`, so nothing is cut off for good.

The server does not rely on the browser. It takes the picture as base64 in JSON, like every other body (the CSRF rules rely on JSON only), with a body limit of 352 KiB on that route alone and at most 256 KiB decoded. It accepts JPEG, PNG and WebP, recognised by their first bytes before libvips sees the file, decodes them with sharp, turns them upright, scales them into 480 × 480 if they are larger, and stores them re-encoded as WebP of at most 128 KiB. Re-encoding keeps nothing but the pixels: no Exif with its GPS position or camera details, no XMP, IPTC, ICC profile or comment. Anything else, a file it cannot decode or one that decodes to more than 16 megapixels is refused. The picture is stored with the candidate, so it goes with the candidate and the election.

A picture is served under its SHA-256, `/api/elections/:id/candidates/:candidateId/picture/:sha256`, as `image/webp` with that hash as a strong ETag, to members of the election; a voter's view of it comes with the voter flow. A new picture gets a new URL and an old URL answers 404, so the one exception to the API's `no-store` rule is safe: a 200 or 304 of this route is `private, max-age=31536000, immutable`, and every other answer of the API, its refusals included, is `no-store`. Access is checked on every request, a revalidation with If-None-Match included.

sharp loads libvips as a shared library under the LGPL-3.0-or-later. The image carries its notice, the source it was built from and the license texts ([`third-party-notices`](../third-party-notices/README.md)).

## Database roles and privileges

Migrations run as the PostgreSQL superuser, which never serves requests. The server connects as `school_election_app`, a role without any attribute that can only connect and use the schema. What it may do with each table and function is one list, `apps/api/lib/runtime-privileges.ts`, and nothing is allowed by default. Every migration run revokes all database, schema, table, sequence and function privileges from PUBLIC and the runtime role, then grants the list again, in one transaction. That covers PostgreSQL's own defaults (PUBLIC may connect to a new database, create temporary tables in it and execute every new function), a database restored from a dump, and grants a newer version no longer lists.

Two of the settings the startup check reads are hidden from such a role. `preload_settings()`, a function the migrations create, returns exactly the preload settings, so the role needs no membership such as `pg_read_all_settings`, which would let it read every setting.

The startup check guards against mistakes: PostgreSQL started without the documented flags, a module preloaded for debugging, or a connection string that names the superuser or the database owner instead of the runtime role. It does not try to detect a superuser who changes the runtime role's rights by hand after a deploy: that works around the deployment, and no check could stop a superuser.

## Audit log

The audit log records what administrators do to an election: who acted (the stable Entra identity, tenant and object id, plus the display name), when, the action, and that action's metadata. It never records voter activity: no ballots or ballot content, no keys, no use of an entitlement, no voter sessions or tokens, no request metadata. Each action has a fixed list of metadata fields with a type each; anything else is refused. The actions and their fields are listed in `apps/api/lib/audit.ts`.

An event is written in the same transaction as the change it records, so a change that fails leaves no event. A lock per election makes concurrent changes wait for each other's events, so each election has one linear chain, and the database refuses anything else: one first event per election, and every other event names an earlier event of the same election, by its sequence number and hash, that no other event names. Since every link points to an earlier event, the links cannot form a cycle. Every event belongs to an election that exists. The application's database role can add and read events, but not change or remove them.

Each event carries the SHA-256 hash of its content and of the previous event's hash, so anyone holding the events can check them without the server. The hash is taken over the UTF-8 bytes of the canonical JSON of `{ version: 1, electionId, at, actor: { tid, oid, name }, action, metadata, prevHash }`, with `prevHash` null for an election's first event and `at` in ISO 8601 UTC with milliseconds. Canonical JSON sorts object keys by UTF-16 code unit, has no whitespace, and allows only objects, arrays, strings, safe integers, booleans and null. `apps/api/lib/audit-chain.ts` computes and verifies the chain, and imports nothing but `node:crypto` and canonical JSON, so an offline verifier can use it as is.

Changing, inserting, removing or reordering an event breaks verification at that event or the next, unless every later hash is recomputed as well. The hashes are not signed: whoever can change the table directly (the database owner; the application's role can only add events) can rewrite the history from any event on, or drop the newest events, and the chain still verifies, only with a different head. Verification therefore vouches for the history up to a head hash that was recorded outside the database and is compared with it, for example with a result, in an export or in the witnesses' notes.

## Statutory rulings

How results are decided, read from the regulation on the election of school representatives (RIS Gesetzesnummer 10009897, checked against the consolidated text of 3 October 2026) or decided for this project where the regulation is silent. Paragraph references are to that regulation.

The Basis column says where each ruling comes from, so that "Confirmed" is never taken to mean that the regulation contains the sentence:

- **Wording:** the regulation says it; the ruling quotes or follows its text.
- **Reading:** the regulation's text, read in a way it does not spell out; the ruling says what was read into it.
- **Project decision:** the regulation is silent, and the project decided. The software refuses to decide such a case itself where the decision belongs to people, such as the school committee. Each confirmed row is mirrored by fixtures in `packages/election-core/test/fixtures/statutory-cases.ts`, keyed by the row's case text, and a test fails when the table and the fixtures drift apart. A case no confirmed row covers must produce an explicit unresolved or lot-required result and never fall back to an alphabetical, id-based or random order.

Alphabetical order is only the order in which candidates are listed on a ballot, the runoff ballot included. It never decides a place.

| Case | Ruling | Basis | Status |
| --- | --- | --- | --- |
| Who is elected in round 1, for every representative (Klassen- or Jahrgangssprecher, Vertreter der Klassensprecher, Abteilungs-, Tages- and Schulsprecher) | Whoever is ranked first, with the ballot's top points (2 or 6), on more than half of the ballots ("auf mehr als der Hälfte der Stimmzettel", § 12 Abs. 3), counted as the valid ballots (next row). Counted from first places, never inferred from point totals. 100 valid ballots with 50 first places is no majority; 51 of 100 and 50 of 99 are | Wording (§ 12 Abs. 3) | Confirmed |
| Base of "more than half" | The valid ballots: complete rankings plus "Nein" votes. Invalid votes (ballots with empty slots) do not count | Reading: § 12 Abs. 3 says "Stimmzettel"; § 12 Abs. 1 has every ballot checked for validity first and counts valid and invalid votes apart, and an invalid ballot ranks nobody, so the base is the valid ballots | Confirmed |
| Two candidates with exactly 50 % of first places each | Nobody has more than half of the first places, so nobody is elected in round 1 and the two go to the runoff (§ 12 Abs. 3). First-round points play no part in this; the runoff ballot lists the two alphabetically | Wording (§ 12 Abs. 3: "mehr als der Hälfte"; § 10 Abs. 3 for the alphabetical list) | Confirmed |
| More than two candidates would enter the runoff on first places | Only the candidates tied on first places are compared: their first-round points decide which of them enter, and if their points are equal as well, the lot decides (§ 12 Abs. 3). A candidate with strictly more first places is never displaced on points. Example: A has 41 first places, B and C 32 each; B and C are compared on points and the one with more points joins A in the runoff. A lot is lot-required: officials draw it and an authorised user records the outcome, which is audited | Wording (§ 12 Abs. 3: points, then the lot); reading: only the tied candidates are compared | Confirmed |
| Who wins the runoff, and a tie in the runoff | The candidate with more valid votes wins; with two candidates that is more than half of the valid ballots. The regulation has no rule for a tie, so the software does not decide one either: the result shows the tie as a case to be settled manually, with no winner and no lot | Reading (§ 12 Abs. 3 provides the runoff, not how it is decided); the tie: project decision | Confirmed |
| Deputies and SGA substitutes | Decided by first-round point totals, with the elected representative's own points left out; runoff votes never change those totals, the runoff only decides who the elected representative is and so whose points are left out. The deputy of a class, department or day representative has the highest total (§ 12 Abs. 4); the Schulsprecher's deputies have the highest and second-highest (§ 12 Abs. 5); at schools with a Schulgemeinschaftsausschuss the three SGA substitutes have the third- to fifth-highest (§ 12 Abs. 6) | Wording (§ 12 Abs. 4 to 6: "im ersten Wahlgang") | Confirmed |
| Ties at the deputy or SGA substitute boundaries | The lot decides directly: "Bei gleicher Punktezahl entscheidet das Los" (§ 12 Abs. 4, 5 and 6). First places are not a secondary discriminator | Wording (§ 12 Abs. 4 to 6) | Confirmed |
| Class and department representatives use the same rule as the Schulsprecher | Yes: § 12 Abs. 3 covers every representative, and § 12 Abs. 4 gives each of them one deputy by first-round points | Wording (§ 12 Abs. 3 and 4) | Confirmed |
| Zero valid ballots in a contest | The regulation has no rule for it. Not decided by the software: the result is an explicit "decision by the school committee required" state with no winner, no lot and no derived positions. The lot rule could be stretched to cover it, but an election without a single valid ballot has failed in a way that needs escalation to people, not automation | Project decision (regulation silent) | Confirmed |
| A contest with a single candidate | A vote takes place with "Ja" and "Nein" as the choices, and an invalid vote remains possible. The candidate is elected with "Ja" on more than half of the valid ballots ("Ja" plus "Nein"). If not, a runoff is impossible and the regulation is silent, so the school committee decides. "Nein" exists because otherwise no valid vote could reject the only candidate: every vote against them would have to be invalid, or invalid votes would have to count as "Nein", which the valid-ballot base rules out | Project decision (regulation silent on a single candidate) | Confirmed |
| Fewer candidates than positions | Slots beyond the number of candidates do not exist on the ballot, and positions nobody can fill stay vacant; the result lists them as vacant. With three Schulsprecher candidates, one becomes Schulsprecher and two become deputies, and the three SGA substitute positions stay vacant (§ 12 Abs. 6 starts at the third-highest remaining total). Filling them later is outside the software | Reading (§ 11 Abs. 2 and 3, § 12 Abs. 4 to 6) | Confirmed |
| By-elections (Neuwahl, § 19) | Different rules apply: the lot decides runoff entry directly, and deputies are elected by most votes (§ 19 Abs. 2) | Wording (§ 19 Abs. 2) | Out of scope for v1 |
