-- migrate:up
create table boards (
  id uuid not null default uuidv7() primary key,
  title varchar(200) not null default 'Untitled board',
  idea_id uuid references ideas(id) on delete set null,
  owner_id uuid not null references users(id),
  -- the whole scene as Excalidraw elements (deleted ones kept briefly so edits merge correctly)
  elements jsonb not null default '[]',
  -- uploaded pictures on the canvas: excalidraw file id -> { url, file_id, mime }
  images jsonb not null default '{}',
  thumb_url text,
  thumb_file_id uuid references files(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index boards_idea_idx on boards (idea_id);
create index boards_updated_idx on boards (updated_at desc);

-- migrate:down
drop table boards;
