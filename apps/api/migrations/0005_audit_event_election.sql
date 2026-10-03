-- Every audit event belongs to an election that exists. A migration of its
-- own, after the one that creates the election table, so that the upgrade
-- test can give the events recorded before that table existed their
-- election first (test/fixtures/upgrade/0004.sql), just as the change that
-- created an election always wrote its first event. On a server no event
-- can predate this: until elections existed, nothing wrote to the log. If
-- one did, the constraint is refused with SQLSTATE 23503 and nothing of
-- this migration is applied.

alter table audit_event
  add constraint audit_event_election foreign key (election_id) references election (id);
