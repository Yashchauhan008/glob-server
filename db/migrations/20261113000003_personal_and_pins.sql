-- migrate:up
-- when someone last signed in, shown on their account card
alter table users
  add column last_login_at timestamptz,
  add column prev_login_at timestamptz,
  add column login_count int not null default 0;

-- a person's own space: only they can see these, and they belong to no team
create table personal_ideas (
  id uuid not null default uuidv7() primary key,
  owner_id uuid not null references users(id) on delete cascade,
  title varchar(255) not null,
  description text not null default '',
  status varchar(20) not null default 'idea'
    check (status in ('idea','planning','building','paused','dropped','shipped')),
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create index idx_personal_ideas_owner on personal_ideas (owner_id);

create table personal_todos (
  id uuid not null default uuidv7() primary key,
  owner_id uuid not null references users(id) on delete cascade,
  title varchar(500) not null,
  done boolean not null default false,
  due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create index idx_personal_todos_owner on personal_todos (owner_id);

-- a place on the map with a tag (visited, next meet point, good place, anything). team_id null = a personal pin
create table pins (
  id uuid not null default uuidv7() primary key,
  team_id uuid references teams(id) on delete cascade,
  owner_id uuid not null references users(id) on delete cascade,
  title varchar(200) not null,
  note text not null default '',
  tag varchar(40) not null default 'saved',
  address text not null default '',
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create index idx_pins_team on pins (team_id) where team_id is not null;
create index idx_pins_owner on pins (owner_id) where team_id is null;

-- migrate:down
drop table pins;
drop table personal_todos;
drop table personal_ideas;
alter table users drop column login_count, drop column prev_login_at, drop column last_login_at;
