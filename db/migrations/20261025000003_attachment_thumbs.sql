-- migrate:up
alter table attachments
  add column thumb_url text,
  add column thumb_file_id uuid references files(id) on delete set null;

-- migrate:down
alter table attachments drop column thumb_file_id, drop column thumb_url;
