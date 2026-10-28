-- migrate:up
-- Only invited emails may sign in. Everyone who already has an account is invited, so nobody is locked out by this.
create table allowed_emails (
  email text primary key,
  added_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
insert into allowed_emails (email) select lower(email) from users on conflict do nothing;

-- a blocked person keeps their data but cannot use Glob until unblocked
alter table users add column blocked_at timestamptz;

-- migrate:down
alter table users drop column blocked_at;
drop table allowed_emails;
