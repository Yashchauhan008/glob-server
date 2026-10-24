-- migrate:up
create table idea_messages (
  id uuid not null default uuidv7() primary key,
  idea_id uuid not null references ideas(id) on delete cascade,
  owner_id uuid not null references users(id),
  body text not null,
  -- a message can be promoted: a problem, a solution to a problem (many per problem), or a conclusion
  tag text check (tag in ('problem', 'solution', 'conclusion')),
  parent_id uuid references idea_messages(id) on delete set null,
  marked_by uuid references users(id) on delete set null,
  marked_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_idea_messages_idea on idea_messages (idea_id, created_at);
create index idx_idea_messages_parent on idea_messages (parent_id);

-- carry the old notes over (same ids, so solution -> problem links survive); asks become plain messages
insert into idea_messages (id, idea_id, owner_id, body, tag, created_at)
select id, idea_id, owner_id,
       case when kind = 'ask' then 'Question: ' || body else body end,
       case kind when 'problem' then 'problem' when 'solution' then 'solution' end,
       created_at
from idea_notes order by created_at;
update idea_messages m set parent_id = n.parent_id
from idea_notes n where n.id = m.id and n.parent_id is not null and exists (select 1 from idea_messages p where p.id = n.parent_id);

create trigger trg_idea_messages_attachments after delete on idea_messages for each row execute function delete_attachments_of();

-- migrate:down
drop trigger trg_idea_messages_attachments on idea_messages;
drop table idea_messages;
