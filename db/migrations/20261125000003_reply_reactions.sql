-- migrate:up

-- a message can answer another one (same chat). If the original goes away the reply stays.
alter table chat_messages add column reply_to_id uuid references chat_messages(id) on delete set null;
alter table dm_messages   add column reply_to_id uuid references dm_messages(id)   on delete set null;

-- one emoji per person per message (workspace chat and personal chat share the table; ids are unique across both)
create table message_reactions (
  message_id uuid not null,
  scope text not null check (scope in ('chat', 'dm')),
  user_id uuid not null references users(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index idx_reactions_message on message_reactions (message_id);

-- migrate:down
drop table if exists message_reactions;
alter table dm_messages drop column if exists reply_to_id;
alter table chat_messages drop column if exists reply_to_id;
