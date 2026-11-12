-- migrate:up
-- the team someone was last working in, so signing in on any device lands them there
alter table users add column last_team_id uuid references teams(id) on delete set null;

-- migrate:down
alter table users drop column last_team_id;
