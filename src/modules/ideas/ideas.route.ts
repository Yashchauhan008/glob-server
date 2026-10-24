import { Router } from 'express';
import z from 'zod';
import withDatabase from '@/shared/utilities/with-database.js';
import { validate } from '@/shared/helpers/validation.helper.js';
import { patchRow, notFound } from '@/shared/utilities/crud.js';

export const IDEA_STATUSES = ['idea', 'planning', 'building', 'paused', 'dropped', 'shipped'] as const;

const ideaBody = z.object({
    title: z.string().trim().min(1).max(255),
    description: z.string().trim().max(10000).default(''),
    status: z.enum(IDEA_STATUSES).default('idea'),
});
const ideaPatch = ideaBody.partial();
const TAGS = ['problem', 'solution', 'conclusion'] as const;
const messageBody = z.object({
    body: z.string().trim().min(1).max(10000),
    tag: z.enum(TAGS).nullish(),
    parent_id: z.string().uuid().nullish(),
});
const messagePatch = z.object({
    tag: z.enum(TAGS).nullable().optional(),
    parent_id: z.string().uuid().nullable().optional(),
});

const router = Router();

router.get('/', withDatabase(async (req, res, _n, db) => {
    const rows = await db.queryAll(
        `SELECT i.*, u.name AS owner_name,
            (SELECT count(*)::int FROM attachments a WHERE a.entity_type = 'idea' AND a.entity_id = i.id) AS attachments,
            (SELECT coalesce(a.thumb_url, a.url) FROM attachments a WHERE a.entity_type = 'idea' AND a.entity_id = i.id AND (a.kind = 'image' OR a.thumb_url IS NOT NULL) ORDER BY (a.kind = 'image') DESC, a.created_at LIMIT 1) AS cover,
            (SELECT count(*)::int FROM idea_messages m WHERE m.idea_id = i.id AND m.tag = 'problem') AS problems,
            (SELECT count(*)::int FROM idea_messages m WHERE m.idea_id = i.id AND m.tag = 'solution') AS solutions,
            (SELECT count(*)::int FROM idea_messages m WHERE m.idea_id = i.id AND m.tag = 'conclusion') AS conclusions,
            (SELECT count(*)::int FROM idea_messages m WHERE m.idea_id = i.id) AS messages,
            (SELECT round(avg(feasibility)::numeric, 1)::float FROM idea_votes v WHERE v.idea_id = i.id) AS feasibility,
            (SELECT count(*)::int FROM idea_votes v WHERE v.idea_id = i.id) AS votes,
            (SELECT feasibility FROM idea_votes v WHERE v.idea_id = i.id AND v.user_id = $1) AS my_vote,
            ((SELECT count(*) FROM idea_messages n WHERE n.idea_id = i.id) + (SELECT count(*) FROM idea_votes v WHERE v.idea_id = i.id)
              + (SELECT count(*) FROM questions q WHERE q.idea_id = i.id))::int AS thoughts,
            (SELECT coalesce(json_agg(c.name), '[]'::json) FROM (
                SELECT DISTINCT u2.name FROM users u2 WHERE u2.id = i.owner_id
                  OR u2.id IN (SELECT owner_id FROM idea_messages WHERE idea_id = i.id)
                  OR u2.id IN (SELECT user_id FROM idea_votes WHERE idea_id = i.id) LIMIT 5) c) AS contributors
         FROM ideas i JOIN users u ON u.id = i.owner_id ORDER BY i.created_at DESC`,
        [req.user!.id],
    );
    res.json({ items: rows });
}));

router.post('/', withDatabase(async (req, res, _n, db) => {
    const b = validate(ideaBody, req.body);
    const row = await db.queryOne(
        'INSERT INTO ideas (owner_id, title, description, status) VALUES ($1,$2,$3,$4) RETURNING *',
        [req.user!.id, b.title, b.description, b.status],
    );
    res.status(201).json(row);
}));

router.get('/:id', withDatabase(async (req, res, _n, db) => {
    const idea = await db.queryOne(
        'SELECT i.*, u.name AS owner_name FROM ideas i JOIN users u ON u.id = i.owner_id WHERE i.id = $1',
        [req.params.id as string],
    );
    if (!idea) return notFound(res);
    const votes = await db.queryAll(
        `SELECT v.user_id, v.feasibility, u.name FROM idea_votes v JOIN users u ON u.id = v.user_id WHERE v.idea_id = $1`,
        [req.params.id as string],
    );
    const talkers = await db.queryAll(
        `SELECT DISTINCT u.name FROM idea_messages m JOIN users u ON u.id = m.owner_id WHERE m.idea_id = $1`,
        [req.params.id as string],
    );
    const messageCount = await db.queryOne('SELECT count(*)::int AS c FROM idea_messages WHERE idea_id = $1', [req.params.id as string]);
    const contributors = [...new Set([idea.owner_name, ...talkers.map((n: any) => n.name), ...votes.map((v: any) => v.name)])].slice(0, 5);
    const avg = votes.length ? votes.reduce((a: number, v: any) => a + v.feasibility, 0) / votes.length : null;
    const questions = await db.queryOne('SELECT count(*)::int AS c FROM questions WHERE idea_id = $1', [req.params.id as string]);
    res.json({
        ...idea, votes, contributors,
        feasibility: avg !== null ? Math.round(avg * 10) / 10 : null,
        thoughts: (messageCount?.c ?? 0) + votes.length + (questions?.c ?? 0),
    });
}));

router.patch('/:id', withDatabase(async (req, res, _n, db) => {
    const row = await patchRow(db, 'ideas', req.params.id as string, validate(ideaPatch, req.body));
    if (!row) return notFound(res);
    res.json(row);
}));

router.put('/:id/vote', withDatabase(async (req, res, _n, db) => {
    const { feasibility } = validate(z.object({ feasibility: z.number().int().min(1).max(5) }), req.body);
    await db.query(
        `INSERT INTO idea_votes (idea_id, user_id, feasibility) VALUES ($1,$2,$3)
         ON CONFLICT (idea_id, user_id) DO UPDATE SET feasibility = $3`,
        [req.params.id as string, req.user!.id, feasibility],
    );
    res.json({ ok: true });
}));

router.delete('/:id', withDatabase(async (req, res, _n, db) => {
    await db.query('DELETE FROM ideas WHERE id = $1', [req.params.id as string]);
    res.status(204).end();
}));

const MESSAGE_SQL = `SELECT m.id, m.idea_id, m.owner_id, m.body, m.tag, m.parent_id, m.marked_at, m.created_at,
        u.name AS owner_name, mu.name AS marked_by_name
    FROM idea_messages m JOIN users u ON u.id = m.owner_id LEFT JOIN users mu ON mu.id = m.marked_by`;

router.get('/:id/messages', withDatabase(async (req, res, _n, db) => {
    const items = await db.queryAll(`${MESSAGE_SQL} WHERE m.idea_id = $1 ORDER BY m.created_at`, [req.params.id as string]);
    res.json({ items });
}));

/** A solution must hang off a problem of the same idea; anything else drops the link. */
async function resolveParent(db: any, ideaId: string, tag: string | null | undefined, parentId: string | null | undefined) {
    if (tag !== 'solution' || !parentId) return null;
    const p = await db.queryOne("SELECT id FROM idea_messages WHERE id = $1 AND idea_id = $2 AND tag = 'problem'", [parentId, ideaId]);
    return p?.id ?? null;
}

router.post('/:id/messages', withDatabase(async (req, res, _n, db) => {
    const b = validate(messageBody, req.body);
    const ideaId = req.params.id as string;
    const parent = await resolveParent(db, ideaId, b.tag, b.parent_id);
    const row = await db.queryOne(
        `INSERT INTO idea_messages (idea_id, owner_id, body, tag, parent_id, marked_by, marked_at)
         VALUES ($1,$2,$3,$4,$5, CASE WHEN $4::text IS NULL THEN NULL ELSE $2::uuid END, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END)
         RETURNING id`,
        [ideaId, req.user!.id, b.body, b.tag ?? null, parent],
    );
    res.status(201).json(await db.queryOne(`${MESSAGE_SQL} WHERE m.id = $1`, [row.id]));
}));

// promote / demote a message: problem, solution (to a problem), conclusion, or back to plain
router.patch('/:id/messages/:mid', withDatabase(async (req, res, _n, db) => {
    const b = validate(messagePatch, req.body);
    const ideaId = req.params.id as string;
    const mid = req.params.mid as string;
    const cur = await db.queryOne('SELECT id, tag FROM idea_messages WHERE id = $1 AND idea_id = $2', [mid, ideaId]);
    if (!cur) return notFound(res);
    const tag = b.tag === undefined ? cur.tag : b.tag;
    const parent = await resolveParent(db, ideaId, tag, b.parent_id);
    await db.query(
        `UPDATE idea_messages SET tag = $2::text, parent_id = $3,
            marked_by = CASE WHEN $2::text IS NULL THEN NULL ELSE $4::uuid END, marked_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END
         WHERE id = $1`,
        [mid, tag, parent, req.user!.id],
    );
    // a message that stops being a problem leaves its solutions as plain messages
    if (cur.tag === 'problem' && tag !== 'problem')
        await db.query("UPDATE idea_messages SET tag = NULL, parent_id = NULL, marked_by = NULL, marked_at = NULL WHERE parent_id = $1 AND tag = 'solution'", [mid]);
    res.json(await db.queryOne(`${MESSAGE_SQL} WHERE m.id = $1`, [mid]));
}));

router.delete('/:id/messages/:mid', withDatabase(async (req, res, _n, db) => {
    const row = await db.queryOne('DELETE FROM idea_messages WHERE id = $1 AND idea_id = $2 AND owner_id = $3 RETURNING id', [
        req.params.mid as string,
        req.params.id as string,
        req.user!.id,
    ]);
    if (!row) return res.status(403).json({ message: 'You can only delete your own messages' });
    res.status(204).end();
}));

export default router;
