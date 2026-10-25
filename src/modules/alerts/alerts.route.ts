import { Router } from 'express';
import withDatabase from '@/shared/utilities/with-database.js';

const router = Router();

/** Counts of things that need the signed-in person's attention, one per nav item. */
router.get('/', withDatabase(async (req, res, _n, db) => {
    const me = req.user!.id;
    const since = typeof req.query.since === 'string' ? new Date(req.query.since) : null;
    const row = await db.queryOne(
        `SELECT
            -- ideas still in play that I have not rated yet
            (SELECT count(*)::int FROM ideas i
              WHERE i.status NOT IN ('dropped', 'shipped')
                AND NOT EXISTS (SELECT 1 FROM idea_votes v WHERE v.idea_id = i.id AND v.user_id = $1)) AS ideas,
            -- open questions from others that I have not answered
            (SELECT count(*)::int FROM questions q
              WHERE q.accepted_answer_id IS NULL AND q.owner_id <> $1
                AND NOT EXISTS (SELECT 1 FROM answers a WHERE a.question_id = q.id AND a.owner_id = $1)) AS qa,
            -- events starting within the next 24 hours
            (SELECT count(*)::int FROM events e WHERE e.starts_at >= now() AND e.starts_at < now() + interval '24 hours') AS calendar,
            -- open tasks due today or already late
            (SELECT count(*)::int FROM todos t WHERE t.done = false AND t.due_date IS NOT NULL AND t.due_date <= current_date) AS tasks,
            -- leads whose follow-up date has come
            (SELECT count(*)::int FROM leads l
              WHERE l.next_follow_up_at IS NOT NULL AND l.next_follow_up_at <= now() AND l.stage NOT IN ('won', 'lost')) AS crm,
            (SELECT count(*)::int FROM products p WHERE p.status = 'down') AS products,
            -- what other people did since I last looked at the feed
            (SELECT count(*)::int FROM activities a
              WHERE a.actor_id <> $1 AND a.entity_type <> 'auth' AND $2::timestamptz IS NOT NULL AND a.created_at > $2) AS activity`,
        [me, since && !Number.isNaN(since.getTime()) ? since.toISOString() : null],
    );
    res.json(row);
}));

export default router;
