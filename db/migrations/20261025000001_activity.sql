-- migrate:up
create table activities (
  id uuid not null default uuidv7() primary key,
  actor_id uuid not null references users(id) on delete cascade,
  verb text not null,
  entity_type text not null,
  entity_id uuid,
  title text not null default '',
  detail text,
  created_at timestamp with time zone not null default now()
);
create index idx_activities_created_at on activities (created_at desc);

-- migrate:down
drop table activities;
