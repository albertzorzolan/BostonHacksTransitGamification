-- Station Egg Hunt schema. All timestamps are written by the app (not SQL now())
-- so tests can drive the clock.

create table users (
  id            uuid primary key,
  username      text not null,
  password_hash text not null,
  created_at    timestamptz not null
);
create unique index users_username_lower on users (lower(username));

-- One row per signed-in device. Only a SHA-256 of the token is stored.
create table sessions (
  id           uuid primary key,
  user_id      uuid not null references users on delete cascade,
  token_hash   bytea not null unique,
  device       text not null default '',
  created_at   timestamptz not null,
  last_seen_at timestamptz not null,
  expires_at   timestamptz not null
);
create index sessions_user on sessions (user_id);

-- Photos live in the database so every server instance can serve them.
create table photos (
  id           uuid primary key,
  content_type text not null default 'image/jpeg',
  data         bytea not null,
  created_at   timestamptz not null
);

-- status: active (playable) | pool (backup for its slot) | retired (gone)
create table eggs (
  id               uuid primary key,
  station_id       text not null,
  level            smallint not null check (level between 1 and 5),
  photo_id         uuid not null references photos,
  hint             text not null default '',
  created_by       uuid not null references users on delete cascade,
  created_at       timestamptz not null,
  status           text not null check (status in ('active', 'pool', 'retired')),
  activated_at     timestamptz,
  retired_at       timestamptz,
  times_found      integer not null default 0,
  avg_find_seconds integer
);
-- At most one active egg per (station, level) slot, enforced by the database.
create unique index eggs_one_active_per_slot on eggs (station_id, level) where status = 'active';
create index eggs_slot on eggs (station_id, level, status);
create index eggs_created_by on eggs (created_by);
create index eggs_active_since on eggs (activated_at) where status = 'active';

create table attempts (
  id            uuid primary key,
  user_id       uuid not null references users on delete cascade,
  egg_id        uuid not null references eggs on delete cascade,
  started_at    timestamptz not null,
  limit_seconds integer not null,
  limit_source  text not null,
  status        text not null check (status in ('open', 'found', 'expired'))
);
create index attempts_user on attempts (user_id);

create table finds (
  id            uuid primary key,
  egg_id        uuid not null references eggs on delete cascade,
  user_id       uuid not null references users on delete cascade,
  station_id    text not null,
  level         smallint not null,
  found_at      timestamptz not null,
  month         text not null, -- "2026-11" in Boston time, for the monthly board
  seconds_taken integer not null,
  points        integer not null,
  base          integer not null,
  bonus         integer not null,
  photo_id      uuid not null references photos,
  verified      boolean not null,
  can_hide      boolean not null default true,
  unique (user_id, egg_id) -- each egg scores once per player
);
create index finds_month_station on finds (month, station_id);
create index finds_egg on finds (egg_id, found_at);

create table reports (
  id         uuid primary key,
  egg_id     uuid not null references eggs on delete cascade,
  user_id    uuid not null references users on delete cascade,
  reason     text not null,
  created_at timestamptz not null,
  unique (egg_id, user_id)
);
