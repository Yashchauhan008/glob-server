-- migrate:up
-- Multi-tenancy: a "team" is a small Glob of its own. Everything people create belongs to exactly one team.

create table teams (
  id uuid not null default uuidv7() primary key,
  name varchar(80) not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table team_members (
  team_id uuid not null references teams(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role varchar(10) not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index idx_team_members_user on team_members (user_id);

-- someone invited to a team who has no account yet; turned into a membership when they sign up
create table team_invites (
  team_id uuid not null references teams(id) on delete cascade,
  email text not null,
  role varchar(10) not null default 'member' check (role in ('owner', 'member')),
  added_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (team_id, email)
);
create index idx_team_invites_email on team_invites (email);

-- everything that exists today moves into one starting team, so nobody loses anything
do $$
declare
  tid uuid;
  first_user uuid := (select id from users order by created_at limit 1);
  t text;
begin
  insert into teams (name, created_by) values ('Glob', first_user) returning id into tid;

  insert into team_members (team_id, user_id, role)
  select tid, u.id, case when u.id = first_user then 'owner' else 'member' end from users u;

  -- emails already invited but not signed up yet join the starting team when they do
  insert into team_invites (team_id, email)
  select tid, a.email from allowed_emails a
  where not exists (select 1 from users u where lower(u.email) = a.email);

  foreach t in array array['ideas','products','leads','todos','events','chat_messages','questions','boards','activities','attachments']
  loop
    execute format('alter table %I add column team_id uuid references teams(id) on delete cascade', t);
    execute format('update %I set team_id = %L', t, tid);
    execute format('alter table %I alter column team_id set not null', t);
    execute format('create index %I on %I (team_id)', 'idx_' || t || '_team', t);
  end loop;
end $$;

-- the same lead email may exist in two different teams
drop index uk_leads_email;
create unique index uk_leads_team_email on leads (team_id, lower(email)) where email is not null;

-- migrate:down
drop index uk_leads_team_email;
create unique index uk_leads_email on leads (lower(email)) where email is not null;
alter table ideas drop column team_id;
alter table products drop column team_id;
alter table leads drop column team_id;
alter table todos drop column team_id;
alter table events drop column team_id;
alter table chat_messages drop column team_id;
alter table questions drop column team_id;
alter table boards drop column team_id;
alter table activities drop column team_id;
alter table attachments drop column team_id;
drop table team_invites;
drop table team_members;
drop table teams;
