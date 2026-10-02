# Design notes

A living record of the decisions behind the election model. Update it in the same pull request that changes the behaviour it describes.

## Rulesets and slots

A ruleset is a fixed, ordered list of slots. Each slot is one function a voter assigns a candidate to, and the statutory points that assignment carries. Function and points are two views of the same slot, so the ballot can show both side by side.

| Ruleset | Slots (points, function) | Used for |
| --- | --- | --- |
| `at-school-speaker-v1` | 6 Schulsprecher/in, 5 1. Stellvertretung, 4 2. Stellvertretung, 3 1. SGA-Stellvertretung, 2 2. SGA-Stellvertretung, 1 3. SGA-Stellvertretung | Schulsprecherwahl |
| `at-representative-v1` | 2 Vertreter/in, 1 Stellvertreter/in | Klassen- and Abteilungssprecherwahl |
| `single-choice-v1` | 1 Stimme | Runoff rounds, anonymous single-choice polls |

The Austrian tables follow the regulation on the election of school representatives (RIS Gesetzesnummer 10009897). Rulesets are constant data in `packages/election-core/src/rulesets.ts`. No configuration, request or import can supply or change points.

Ruleset ids carry a version. A ruleset is never edited in place; a change gets a new id, so a result stored under an old id can always be recomputed with the rules it was counted under.

### Active slots

A contest with `n` candidates uses the first `min(n, slots)` slots of its ruleset, and only those. A four-candidate Schulsprecherwahl has the slots 6, 5, 4 and 3. The 2- and 1-point slots do not exist on that ballot, because no candidate would be left to fill them.

## Ballot representation

A ballot is an ordered list of candidate ids. Position 0 fills the highest slot, position 1 the next, and so on. The slot, and with it the points, follows from the position alone; points are never submitted and never stored.

That form cannot express two candidates in one slot, one candidate in two slots without repeating the id, or a skipped slot. Map- or object-shaped ballots are rejected rather than interpreted.

A ballot is valid when all of the following hold:

- it is an array of strings without holes;
- its length equals the number of active slots: shorter is `incomplete`, longer is `inactive-slot`;
- every id names a candidate of the contest (`unknown-candidate` otherwise);
- no id appears twice (`duplicate-candidate` otherwise).

Validation errors carry positions and counts only, never candidate ids, so a rejected ballot can be logged or answered without revealing its content.

### Completeness

Every active slot must be filled. With `n` ≤ 6 candidates on a Schulsprecher ballot every candidate appears exactly once; with more, exactly six distinct candidates are ranked and the rest receive zero points from that ballot.

Completeness is a validity rule, not a convenience. The lower slots decide the deputies, the SGA substitutes and point-based runoff tiebreaks. A voter who could award the top points and withhold the rest could steer those positions strategically.

## Why points are never rescaled

For `n` ≤ 6 candidates the active statutory scale is `6, 5, …, 7−n`. A rescaled scale `n, n−1, …, 1` may look more natural, and on complete ballots it gives the same outcome: every candidate appears once on every ballot, so each candidate's statutory total over `V` ballots is

```text
statutoryTotal = rescaledTotal + V · (6 − n)
```

The constant is the same for every candidate, so ordering, ties, deputy order and every comparison of totals are identical. The property tests in `packages/election-core/test/statistics.test.ts` check this exhaustively for small cases and on seeded random ballot sets.

The equivalence depends on complete ballots; with optional rankings the offset would differ between candidates. The code still uses the statutory points everywhere, because they match the regulation and the audit output one to one, keep a single counting algorithm without special cases, and preserve the link between points and function.

## Blank ballots

Version 1 has no blank ballot. A voter who does not want to vote in a contest leaves it; the entitlement stays unused, and the base for the majority rule is unambiguously the number of valid ballots. If a blank vote is wanted later, it becomes a separate, explicitly counted ballot form that is excluded from that base.

## Determinism

`election-core` is pure: no I/O, no imports from outside the package, and no clock or randomness (ESLint enforces all three). The same configuration and the same ballots always produce the same figures, in the API, in the browser and in an offline verifier. `TALLY_VERSION` changes with any change to counting semantics and is stored with every result.

Counting arithmetic is integer-only, and per-candidate output follows the contest's candidate order, so it never depends on the order in which ballots arrive.

## Statutory rulings

Cases the regulation leaves open, or where the reading must be confirmed with the school community committee before result computation is implemented. Each confirmed row becomes a test fixture. Until a row is confirmed, the code returns an explicit unresolved or lot-required result for that case and never falls back to an alphabetical, id-based or random order.

| Case | Ruling | Status |
| --- | --- | --- |
| Principal position: elected in round 1 only with more than half of the valid ballots as first places | Strictly greater than 50 % of first places, counted directly, never inferred from points | To implement |
| Two candidates with exactly 50 % of first places each | | Pending |
| Tie for the second runoff place on first places that first-round points cannot break | | Pending |
| Ties at the deputy or SGA substitute boundaries: lot directly, or first places as a secondary discriminator | | Pending |
| Zero valid ballots in a contest | | Pending |
| A contest with a single candidate | | Pending |
| Vacancies when fewer candidates stand than there are positions | | Pending |
| Class and department representatives use the same majority and runoff rule as the principal position | | Pending |
| Tie in a two-candidate runoff | | Pending |
