-- migrate:up

-- a call (voice or video), one to one or for a group, run on its own LiveKit room
create table calls (
  id uuid not null default uuidv7() primary key,
  team_id uuid not null references teams(id) on delete cascade,
  kind text not null check (kind in ('voice', 'video')),
  scope text not null check (scope in ('dm', 'group')),
  initiator_id uuid not null references users(id) on delete cascade,
  room text not null,
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  end_reason text
);
create index idx_calls_team_active on calls (team_id) where ended_at is null;

create table call_participants (
  call_id uuid not null references calls(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  state text not null default 'ringing' check (state in ('ringing', 'joined', 'declined', 'missed', 'left', 'busy')),
  invited_at timestamptz not null default now(),
  joined_at timestamptz,
  left_at timestamptz,
  primary key (call_id, user_id)
);
create index idx_call_participants_user on call_participants (user_id, state);

-- chats can show "Missed voice call", "Video call 2:05" and so on
alter table chat_messages drop constraint if exists chat_messages_kind_check;
alter table chat_messages add constraint chat_messages_kind_check check (kind in ('text', 'image', 'video', 'audio', 'file', 'call'));
alter table dm_messages drop constraint if exists dm_messages_kind_check;
alter table dm_messages add constraint dm_messages_kind_check check (kind in ('text', 'image', 'video', 'audio', 'file', 'call'));

-- migrate:down
alter table dm_messages drop constraint if exists dm_messages_kind_check;
alter table dm_messages add constraint dm_messages_kind_check check (kind in ('text', 'image', 'video', 'audio', 'file'));
alter table chat_messages drop constraint if exists chat_messages_kind_check;
alter table chat_messages add constraint chat_messages_kind_check check (kind in ('text', 'image', 'video', 'audio', 'file'));
drop table if exists call_participants;
drop table if exists calls;
