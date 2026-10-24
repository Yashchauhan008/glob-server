-- migrate:up

create table idea_votes (
  idea_id uuid not null references ideas(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  feasibility int not null check (feasibility between 1 and 5),
  created_at timestamptz not null default now(),
  primary key (idea_id, user_id)
);

create table events (
  id uuid not null default uuidv7() primary key,
  owner_id uuid not null references users(id),
  title varchar(255) not null,
  kind varchar(20) not null default 'meeting' check (kind in ('meeting','appointment','task','reminder')),
  starts_at timestamptz not null,
  ends_at timestamptz,
  notes text not null default '',
  idea_id uuid references ideas(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  created_at timestamptz not null default now()
);
create index idx_events_starts on events(starts_at);

create table chat_messages (
  id uuid not null default uuidv7() primary key,
  user_id uuid not null references users(id),
  body text not null,
  created_at timestamptz not null default now()
);

create table questions (
  id uuid not null default uuidv7() primary key,
  owner_id uuid not null references users(id),
  title varchar(500) not null,
  body text not null default '',
  idea_id uuid references ideas(id) on delete set null,
  accepted_answer_id uuid,
  created_at timestamptz not null default now()
);

create table answers (
  id uuid not null default uuidv7() primary key,
  question_id uuid not null references questions(id) on delete cascade,
  owner_id uuid not null references users(id),
  body text not null,
  created_at timestamptz not null default now()
);
create index idx_answers_question on answers(question_id);

-- migrate:down
drop table answers; drop table questions; drop table chat_messages; drop table events; drop table idea_votes;
