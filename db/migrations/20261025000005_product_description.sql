-- migrate:up
alter table products add column description text not null default '';

-- migrate:down
alter table products drop column description;
