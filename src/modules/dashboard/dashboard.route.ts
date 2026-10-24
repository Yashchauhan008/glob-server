import { Router } from 'express';
import withDatabase from '@/shared/utilities/with-database.js';

const router = Router();

router.get('/', withDatabase(async (_req, res, _n, db) => {
    const [team, ideaCounts, openNotes, products, todosToday, leadCounts, followUps, monthly, mapLeads] =
        await Promise.all([
            db.queryOne(
                `SELECT (SELECT count(*) FROM ideas)::int AS ideas,
                    (SELECT count(*) FROM idea_notes)::int AS notes,
                    (SELECT count(*) FROM idea_votes)::int AS votes,
                    (SELECT count(*) FROM questions)::int AS questions,
                    (SELECT count(*) FROM questions WHERE accepted_answer_id IS NULL)::int AS open_questions,
                    (SELECT count(*) FROM answers)::int AS answers,
                    (SELECT count(*) FROM chat_messages)::int AS messages,
                    (SELECT count(*) FROM events WHERE starts_at >= now())::int AS upcoming_events,
                    (SELECT round(avg(feasibility)::numeric, 1)::float FROM idea_votes) AS feasibility,
                    (SELECT count(*) FROM todos WHERE done)::int AS todos_done,
                    (SELECT count(*) FROM todos)::int AS todos_total`,
            ),
            db.queryAll('SELECT status, count(*)::int AS count FROM ideas GROUP BY status'),
            db.queryAll(
                `SELECT n.id, n.kind, n.body, n.idea_id, i.title AS idea_title FROM idea_notes n
                 JOIN ideas i ON i.id = n.idea_id
                 WHERE n.kind IN ('problem','ask')
                   AND NOT EXISTS (SELECT 1 FROM idea_notes s WHERE s.parent_id = n.id AND s.kind = 'solution')
                 ORDER BY n.created_at DESC LIMIT 20`,
            ),
            db.queryAll('SELECT id, name, url, status FROM products ORDER BY created_at DESC'),
            db.queryAll(
                `SELECT id, title, done, due_date FROM todos
                 WHERE done = false AND due_date <= current_date ORDER BY due_date`,
            ),
            db.queryAll('SELECT stage, count(*)::int AS count FROM leads GROUP BY stage'),
            db.queryAll(
                `SELECT id, name, company, next_follow_up_at FROM leads
                 WHERE next_follow_up_at IS NOT NULL AND next_follow_up_at <= now() + interval '1 day'
                   AND stage NOT IN ('won','lost') ORDER BY next_follow_up_at LIMIT 20`,
            ),
            db.queryOne(
                `SELECT count(*) FILTER (WHERE stage = 'won')::int AS won,
                        count(*) FILTER (WHERE stage = 'lost')::int AS lost
                 FROM leads WHERE closed_at >= date_trunc('month', now())`,
            ),
            db.queryAll(
                `SELECT id, name, company, stage, latitude, longitude, address, phone, email
                 FROM leads WHERE latitude IS NOT NULL AND longitude IS NOT NULL`,
            ),
        ]);
    res.json({
        team,
        ideas: ideaCounts,
        open_notes: openNotes,
        products,
        todos_due: todosToday,
        leads: leadCounts,
        follow_ups: followUps,
        month: monthly,
        map_leads: mapLeads,
    });
}));

export default router;
