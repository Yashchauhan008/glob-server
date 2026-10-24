-- migrate:up

create table ideas (
  id uuid not null default uuidv7() primary key,
  owner_id uuid not null references users(id),
  title varchar(255) not null,
  description text not null default '',
  status varchar(20) not null default 'idea'
    check (status in ('idea','planning','building','paused','dropped','shipped')),
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table idea_notes (
  id uuid not null default uuidv7() primary key,
  idea_id uuid not null references ideas(id) on delete cascade,
  owner_id uuid not null references users(id),
  kind varchar(20) not null check (kind in ('problem','ask','solution')),
  body text not null,
  parent_id uuid references idea_notes(id) on delete set null,
  created_at timestamptz not null default now()
);
create index idx_idea_notes_idea on idea_notes(idea_id);

create table products (
  id uuid not null default uuidv7() primary key,
  owner_id uuid not null references users(id),
  name varchar(255) not null,
  url text not null default '',
  status varchar(20) not null default 'building' check (status in ('up','down','building')),
  idea_id uuid references ideas(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table leads (
  id uuid not null default uuidv7() primary key,
  owner_id uuid not null references users(id),
  name varchar(255) not null,
  email varchar(255),
  phone varchar(50),
  company varchar(255),
  source varchar(255),
  stage varchar(20) not null default 'new'
    check (stage in ('new','contacted','qualified','proposal','negotiation','won','lost')),
  lost_reason text,
  next_follow_up_at timestamptz,
  address text,
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create unique index uk_leads_email on leads(lower(email)) where email is not null;

create table lead_activities (
  id uuid not null default uuidv7() primary key,
  lead_id uuid not null references leads(id) on delete cascade,
  owner_id uuid not null references users(id),
  kind varchar(20) not null check (kind in ('call','email','meeting','note','stage_change')),
  body text not null default '',
  created_at timestamptz not null default now()
);
create index idx_lead_activities_lead on lead_activities(lead_id);

create table todos (
  id uuid not null default uuidv7() primary key,
  owner_id uuid not null references users(id),
  title varchar(500) not null,
  done boolean not null default false,
  due_date date,
  idea_id uuid references ideas(id) on delete set null,
  note_id uuid references idea_notes(id) on delete set null,
  product_id uuid references products(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

-- migrate:down

drop table todos;
drop table lead_activities;
drop table leads;
drop table products;
drop table idea_notes;
drop table ideas;
