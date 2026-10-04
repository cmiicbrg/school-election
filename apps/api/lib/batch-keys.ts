// The batches with their key counts, in one pass over the keys: a derived
// table every query that needs a batch's count selects from as `b`, with
// the batch's columns and `keys`. PostgreSQL pushes a predicate on the
// batch's columns into it, so a query for one election or one batch
// reads that election's or that batch's keys alone.

/** `from ${BATCHES_WITH_KEYS} b`: id, election_id, voter_group_id, round_kind, state, keys. */
export const BATCHES_WITH_KEYS = `(select b.id, b.election_id, b.voter_group_id, b.round_kind, b.state, count(c.id)::int as keys
     from credential_batch b left join credential c on c.batch_id = b.id
    group by b.id, b.election_id, b.voter_group_id, b.round_kind, b.state)`
