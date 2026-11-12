-- migrate:up
-- A block of HTML/JS a person pastes onto their personal dashboard. `data` is what the block saved with localStorage,
-- kept here as JSON so it survives refreshes and works on every device.
create table personal_widgets (
  id uuid not null default uuidv7() primary key,
  owner_id uuid not null references users(id) on delete cascade,
  title varchar(120) not null default 'Untitled block',
  html text not null default '',
  data jsonb not null default '{}',
  position int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create index idx_personal_widgets_owner on personal_widgets (owner_id, position);

-- migrate:down
drop table personal_widgets;
