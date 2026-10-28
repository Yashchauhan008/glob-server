-- migrate:up
-- total time each person has had Glob open (counted by the server once a minute while they are connected)
alter table users add column live_seconds bigint not null default 0;

-- who finished a task, so credit goes to them and not to whoever wrote it
alter table todos add column completed_by uuid references users(id) on delete set null;
alter table todos add column completed_at timestamptz;

-- tasks finished before this: use the activity log ("completed a task") to find who ticked them off;
-- where it has no record, the person who wrote the task is the best guess
update todos t set
  completed_by = coalesce(
    (select a.actor_id from activities a where a.entity_type = 'todos' and a.entity_id = t.id and a.verb = 'completed a task'
      order by a.created_at desc limit 1), t.owner_id),
  completed_at = coalesce(
    (select a.created_at from activities a where a.entity_type = 'todos' and a.entity_id = t.id and a.verb = 'completed a task'
      order by a.created_at desc limit 1), t.updated_at, t.created_at)
where t.done;

-- migrate:down
alter table todos drop column completed_at, drop column completed_by;
alter table users drop column live_seconds;
