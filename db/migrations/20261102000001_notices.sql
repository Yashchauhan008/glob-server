-- migrate:up
-- An invite sent while someone is away. Delivered the next time they open Glob.
create table notices (
  id uuid not null default uuidv7() constraint pk_notices_id primary key,
  user_id uuid references users(id) on delete cascade,
  email text not null,
  title text not null,
  body text not null,
  tag text not null,
  created_at timestamptz not null default now()
);
create index notices_user_idx on notices (user_id);
create index notices_email_idx on notices (email);

-- migrate:down
drop table notices;
