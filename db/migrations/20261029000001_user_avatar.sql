-- migrate:up
alter table users add column avatar_url text;

-- migrate:down
alter table users drop column avatar_url;
