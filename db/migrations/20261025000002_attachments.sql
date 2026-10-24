-- migrate:up
create table attachments (
  id uuid not null default uuidv7() primary key,
  entity_type text not null,
  entity_id uuid not null,
  kind text not null check (kind in ('link', 'image')),
  url text not null,
  title text not null default '',
  file_id uuid references files(id) on delete set null,
  owner_id uuid not null references users(id) on delete cascade,
  created_at timestamp with time zone not null default now()
);
create index idx_attachments_entity on attachments (entity_type, entity_id);

-- attachments follow their parent row
create function delete_attachments_of() returns trigger language plpgsql as $$
begin
  delete from attachments where entity_id = old.id;
  return old;
end $$;
create trigger trg_ideas_attachments after delete on ideas for each row execute function delete_attachments_of();
create trigger trg_idea_notes_attachments after delete on idea_notes for each row execute function delete_attachments_of();
create trigger trg_questions_attachments after delete on questions for each row execute function delete_attachments_of();
create trigger trg_todos_attachments after delete on todos for each row execute function delete_attachments_of();
create trigger trg_events_attachments after delete on events for each row execute function delete_attachments_of();
create trigger trg_leads_attachments after delete on leads for each row execute function delete_attachments_of();

-- migrate:down
drop trigger trg_leads_attachments on leads;
drop trigger trg_events_attachments on events;
drop trigger trg_todos_attachments on todos;
drop trigger trg_questions_attachments on questions;
drop trigger trg_idea_notes_attachments on idea_notes;
drop trigger trg_ideas_attachments on ideas;
drop function delete_attachments_of();
drop table attachments;
