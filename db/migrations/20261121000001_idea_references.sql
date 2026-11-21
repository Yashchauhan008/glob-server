-- migrate:up
-- Ideas can keep many references: a link, image, note, video or document.
alter table attachments drop constraint if exists attachments_kind_check;
alter table attachments add constraint attachments_kind_check
  check (kind in ('link', 'image', 'text', 'video', 'document'));
alter table attachments add column if not exists body text not null default '';

-- migrate:down
alter table attachments drop column if exists body;
alter table attachments drop constraint if exists attachments_kind_check;
alter table attachments add constraint attachments_kind_check
  check (kind in ('link', 'image'));
