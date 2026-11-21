-- Rounds can be given up, and remember when they ended, so a player can resume a
-- running round and has to wait before retrying an egg they ran out of time on.
alter table attempts drop constraint if exists attempts_status_check;
alter table attempts add constraint attempts_status_check
  check (status in ('open', 'found', 'expired', 'given_up'));
alter table attempts add column ended_at timestamptz;
create index attempts_user_egg on attempts (user_id, egg_id, started_at desc);
