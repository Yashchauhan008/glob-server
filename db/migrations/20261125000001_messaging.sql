-- migrate:up

-- workspace chat can now carry pictures, videos, voice notes and documents
alter table chat_messages
  add column kind text not null default 'text' check (kind in ('text', 'image', 'video', 'audio', 'file')),
  add column file_url text,
  add column file_name text,
  add column mime text,
  add column duration_ms int,
  add column client_id text;
create unique index uq_chat_client on chat_messages (user_id, client_id) where client_id is not null;
create index idx_chat_team_created on chat_messages (team_id, created_at desc);

-- personal (one to one) chat, inside a workspace
create table dm_messages (
  id uuid not null default uuidv7() primary key,
  team_id uuid not null references teams(id) on delete cascade,
  sender_id uuid not null references users(id) on delete cascade,
  recipient_id uuid not null references users(id) on delete cascade,
  body text not null default '',
  kind text not null default 'text' check (kind in ('text', 'image', 'video', 'audio', 'file')),
  file_url text,
  file_name text,
  mime text,
  duration_ms int,
  client_id text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  read_at timestamptz,
  check (sender_id <> recipient_id)
);
create unique index uq_dm_client on dm_messages (sender_id, client_id) where client_id is not null;
create index idx_dm_pair on dm_messages (team_id, sender_id, recipient_id, created_at desc);
create index idx_dm_unread on dm_messages (recipient_id, team_id) where read_at is null;

-- how far each person has read the workspace chat
create table chat_reads (
  user_id uuid not null references users(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (user_id, team_id)
);

-- the notification centre
create table notifications (
  id uuid not null default uuidv7() primary key,
  user_id uuid not null references users(id) on delete cascade,
  team_id uuid references teams(id) on delete cascade,
  type text not null,
  label text not null default '',
  title text not null,
  body text not null default '',
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index idx_notifications_user on notifications (user_id, created_at desc);
create index idx_notifications_unread on notifications (user_id) where read_at is null;

-- phones that should get push notifications (Firebase Cloud Messaging)
create table device_tokens (
  token text not null primary key,
  user_id uuid not null references users(id) on delete cascade,
  platform text not null default 'android',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_device_tokens_user on device_tokens (user_id);

-- migrate:down
drop table if exists device_tokens;
drop table if exists notifications;
drop table if exists chat_reads;
drop table if exists dm_messages;
drop index if exists idx_chat_team_created;
drop index if exists uq_chat_client;
alter table chat_messages
  drop column if exists client_id,
  drop column if exists duration_ms,
  drop column if exists mime,
  drop column if exists file_name,
  drop column if exists file_url,
  drop column if exists kind;
