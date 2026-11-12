import { Router } from 'express';
import withDatabase from '@/shared/utilities/with-database.js';

const router = Router();

router.get('/', withDatabase(async (req, res, _n, db) => {
    const t = [req.team!.id]; // $1 in every query below: only this team's numbers
    const [team, ideaCounts, openNotes, products, todosToday, leadCounts, followUps, monthly, mapLeads] =
        await Promise.all([
            db.queryOne(
                `SELECT (SELECT count(*) FROM ideas WHERE team_id = $1)::int AS ideas,
                    (SELECT count(*) FROM idea_messages m JOIN ideas i ON i.id = m.idea_id WHERE i.team_id = $1)::int AS notes,
                    (SELECT count(*) FROM idea_votes v JOIN ideas i ON i.id = v.idea_id WHERE i.team_id = $1)::int AS votes,
                    (SELECT count(*) FROM questions WHERE team_id = $1)::int AS questions,
                    (SELECT count(*) FROM questions WHERE team_id = $1 AND accepted_answer_id IS NULL)::int AS open_questions,
                    (SELECT count(*) FROM answers a JOIN questions q ON q.id = a.question_id WHERE q.team_id = $1)::int AS answers,
                    (SELECT count(*) FROM chat_messages WHERE team_id = $1)::int AS messages,
                    (SELECT count(*) FROM events WHERE team_id = $1 AND starts_at >= now())::int AS upcoming_events,
                    (SELECT round(avg(v.feasibility)::numeric, 1)::float FROM idea_votes v JOIN ideas i ON i.id = v.idea_id WHERE i.team_id = $1) AS feasibility,
                    (SELECT count(*) FROM todos WHERE team_id = $1 AND done)::int AS todos_done,
                    (SELECT count(*) FROM todos WHERE team_id = $1)::int AS todos_total`,
                t,
            ),
            db.queryAll('SELECT status, count(*)::int AS count FROM ideas WHERE team_id = $1 GROUP BY status', t),
            db.queryAll(
                `SELECT n.id, n.tag AS kind, n.body, n.idea_id, i.title AS idea_title FROM idea_messages n
                 JOIN ideas i ON i.id = n.idea_id
                 WHERE i.team_id = $1 AND n.tag = 'problem'
                   AND NOT EXISTS (SELECT 1 FROM idea_messages s WHERE s.parent_id = n.id AND s.tag = 'solution')
                 ORDER BY n.created_at DESC LIMIT 20`,
                t,
            ),
            db.queryAll('SELECT id, name, url, status FROM products WHERE team_id = $1 ORDER BY created_at DESC', t),
            db.queryAll(
                `SELECT id, title, done, due_date FROM todos
                 WHERE team_id = $1 AND done = false AND due_date <= current_date ORDER BY due_date`,
                t,
            ),
            db.queryAll('SELECT stage, count(*)::int AS count FROM leads WHERE team_id = $1 GROUP BY stage', t),
            db.queryAll(
                `SELECT id, name, company, next_follow_up_at FROM leads
                 WHERE team_id = $1 AND next_follow_up_at IS NOT NULL AND next_follow_up_at <= now() + interval '1 day'
                   AND stage NOT IN ('won','lost') ORDER BY next_follow_up_at LIMIT 20`,
                t,
            ),
            db.queryOne(
                `SELECT count(*) FILTER (WHERE stage = 'won')::int AS won,
                        count(*) FILTER (WHERE stage = 'lost')::int AS lost
                 FROM leads WHERE team_id = $1 AND closed_at >= date_trunc('month', now())`,
                t,
            ),
            db.queryAll(
                `SELECT id, name, company, stage, latitude, longitude, address, phone, email
                 FROM leads WHERE team_id = $1 AND latitude IS NOT NULL AND longitude IS NOT NULL`,
                t,
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
