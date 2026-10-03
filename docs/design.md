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

A **runoff** or an anonymous single-choice poll (`runoffResult`) ends `elected` (more valid votes; in a poll, the most), `tie` (equal votes at the top: no winner and no lot, settled manually) or `committee-decision` (zero valid ballots). A poll with a single option follows the single-candidate rule. A runoff result names the first-round contest it decides, and a poll names none, so neither a poll nor the runoff of another contest with the same two candidates can be applied as a contest's runoff.

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

## Audit log

The audit log records what administrators do to an election: who acted (the stable Entra identity, tenant and object id, plus the display name), when, the action, and that action's metadata. It never records voter activity: no ballots or ballot content, no keys, no use of an entitlement, no voter sessions or tokens, no request metadata. Each action has a fixed list of metadata fields with a type each; anything else is refused. The actions and their fields are listed in `apps/api/lib/audit.ts`.

An event is written in the same transaction as the change it records, so a change that fails leaves no event. A lock per election makes concurrent changes wait for each other's events, so each election has one linear chain, and the database refuses anything else: one first event per election, and every other event names an earlier event of the same election, by its sequence number and hash, that no other event names. Since every link points to an earlier event, the links cannot form a cycle. The application's database role can add and read events, but not change or remove them.

Each event carries the SHA-256 hash of its content and of the previous event's hash, so anyone holding the events can check them without the server. The hash is taken over the UTF-8 bytes of the canonical JSON of `{ version: 1, electionId, at, actor: { tid, oid, name }, action, metadata, prevHash }`, with `prevHash` null for an election's first event and `at` in ISO 8601 UTC with milliseconds. Canonical JSON sorts object keys by UTF-16 code unit, has no whitespace, and allows only objects, arrays, strings, safe integers, booleans and null. `apps/api/lib/audit-chain.ts` computes and verifies the chain, and imports nothing but `node:crypto` and canonical JSON, so an offline verifier can use it as is.

Changing, inserting, removing or reordering an event breaks verification at that event or the next, unless every later hash is recomputed as well. The hashes are not signed: whoever can change the table directly (the database owner; the application's role can only add events) can rewrite the history from any event on, or drop the newest events, and the chain still verifies, only with a different head. Verification therefore vouches for the history up to a head hash that was recorded outside the database and is compared with it, for example with a result, in an export or in the witnesses' notes.

## Statutory rulings

How results are decided, read from the regulation on the election of school representatives (RIS Gesetzesnummer 10009897, checked against the consolidated text of 2 October 2026) or decided for this project where the regulation is silent. Paragraph references are to that regulation. Each confirmed row is mirrored by fixtures in `packages/election-core/test/fixtures/statutory-cases.ts`, keyed by the row's case text, and a test fails when the table and the fixtures drift apart. A case no confirmed row covers must produce an explicit unresolved or lot-required result and never fall back to an alphabetical, id-based or random order.

Alphabetical order is only the order in which candidates are listed on a ballot, the runoff ballot included. It never decides a place.

| Case | Ruling | Status |
| --- | --- | --- |
| Who is elected in round 1, for every representative (Klassen- or Jahrgangssprecher, Vertreter der Klassensprecher, Abteilungs-, Tages- and Schulsprecher) | Whoever is ranked first, with the ballot's top points (2 or 6), on more than half of the valid ballots (§ 12 Abs. 3). Counted from first places, never inferred from point totals. 100 valid ballots with 50 first places is no majority; 51 of 100 and 50 of 99 are | Confirmed |
| Base of "more than half" | The valid ballots: complete rankings plus "Nein" votes. Invalid votes (ballots with empty slots) do not count | Confirmed |
| Two candidates with exactly 50 % of first places each | Nobody has more than half of the first places, so nobody is elected in round 1 and the two go to the runoff (§ 12 Abs. 3). First-round points play no part in this; the runoff ballot lists the two alphabetically | Confirmed |
| More than two candidates would enter the runoff on first places | Only the candidates tied on first places are compared: their first-round points decide which of them enter, and if their points are equal as well, the lot decides (§ 12 Abs. 3). A candidate with strictly more first places is never displaced on points. Example: A has 41 first places, B and C 32 each; B and C are compared on points and the one with more points joins A in the runoff. A lot is lot-required: officials draw it and an authorised user records the outcome, which is audited | Confirmed |
| Who wins the runoff, and a tie in the runoff | The candidate with more valid votes wins; with two candidates that is more than half of the valid ballots. The regulation has no rule for a tie, so the software does not decide one either: the result shows the tie as a case to be settled manually, with no winner and no lot | Confirmed |
| Deputies and SGA substitutes | Decided by first-round point totals, with the elected representative's own points left out; runoff votes never change those totals, the runoff only decides who the elected representative is and so whose points are left out. The deputy of a class, department or day representative has the highest total (§ 12 Abs. 4); the Schulsprecher's deputies have the highest and second-highest (§ 12 Abs. 5); at schools with a Schulgemeinschaftsausschuss the three SGA substitutes have the third- to fifth-highest (§ 12 Abs. 6) | Confirmed |
| Ties at the deputy or SGA substitute boundaries | The lot decides directly: "Bei gleicher Punktezahl entscheidet das Los" (§ 12 Abs. 4, 5 and 6). First places are not a secondary discriminator | Confirmed |
| Class and department representatives use the same rule as the Schulsprecher | Yes: § 12 Abs. 3 covers every representative, and § 12 Abs. 4 gives each of them one deputy by first-round points | Confirmed |
| Zero valid ballots in a contest | The regulation has no rule for it. Not decided by the software: the result is an explicit "decision by the school committee required" state with no winner, no lot and no derived positions | Confirmed |
| A contest with a single candidate | A vote takes place with "Ja" and "Nein" as the choices, and an invalid vote remains possible. The candidate is elected with "Ja" on more than half of the valid ballots ("Ja" plus "Nein"). If not, a runoff is impossible and the regulation is silent, so the school committee decides | Confirmed |
| Fewer candidates than positions | Slots beyond the number of candidates do not exist on the ballot, and positions nobody can fill stay vacant; the result lists them as vacant. With three Schulsprecher candidates, one becomes Schulsprecher and two become deputies, and the three SGA substitute positions stay vacant (§ 12 Abs. 6 starts at the third-highest remaining total). Filling them later is outside the software | Confirmed |
| By-elections (Neuwahl, § 19) | Different rules apply: the lot decides runoff entry directly, and deputies are elected by most votes (§ 19 Abs. 2) | Out of scope for v1 |
