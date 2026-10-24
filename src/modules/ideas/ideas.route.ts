import { Router } from 'express';
import z from 'zod';
import withDatabase from '@/shared/utilities/with-database.js';
import { validate } from '@/shared/helpers/validation.helper.js';
import { patchRow, notFound } from '@/shared/utilities/crud.js';

export const IDEA_STATUSES = ['idea', 'planning', 'building', 'paused', 'dropped', 'shipped'] as const;
const NOTE_KINDS = ['problem', 'ask', 'solution'] as const;

const ideaBody = z.object({
    title: z.string().trim().min(1).max(255),
    description: z.string().trim().max(10000).default(''),
    status: z.enum(IDEA_STATUSES).default('idea'),
});
const ideaPatch = ideaBody.partial();
const noteBody = z.object({
    kind: z.enum(NOTE_KINDS),
    body: z.string().trim().min(1).max(10000),
    parent_id: z.string().uuid().nullish(),
});

const router = Router();

router.get('/', withDatabase(async (req, res, _n, db) => {
    const rows = await db.queryAll(
        `SELECT i.*, u.name AS owner_name,
            (SELECT count(*)::int FROM attachments a WHERE a.entity_type = 'idea' AND a.entity_id = i.id) AS attachments,
            (SELECT coalesce(a.thumb_url, a.url) FROM attachments a WHERE a.entity_type = 'idea' AND a.entity_id = i.id AND (a.kind = 'image' OR a.thumb_url IS NOT NULL) ORDER BY (a.kind = 'image') DESC, a.created_at LIMIT 1) AS cover,
            (SELECT count(*)::int FROM idea_notes n WHERE n.idea_id = i.id AND n.kind = 'problem') AS problems,
            (SELECT count(*)::int FROM idea_notes n WHERE n.idea_id = i.id AND n.kind = 'ask') AS asks,
            (SELECT count(*)::int FROM idea_notes n WHERE n.idea_id = i.id AND n.kind = 'solution') AS solutions,
            (SELECT round(avg(feasibility)::numeric, 1)::float FROM idea_votes v WHERE v.idea_id = i.id) AS feasibility,
            (SELECT count(*)::int FROM idea_votes v WHERE v.idea_id = i.id) AS votes,
            (SELECT feasibility FROM idea_votes v WHERE v.idea_id = i.id AND v.user_id = $1) AS my_vote,
            ((SELECT count(*) FROM idea_notes n WHERE n.idea_id = i.id) + (SELECT count(*) FROM idea_votes v WHERE v.idea_id = i.id)
              + (SELECT count(*) FROM questions q WHERE q.idea_id = i.id))::int AS thoughts,
            (SELECT coalesce(json_agg(c.name), '[]'::json) FROM (
                SELECT DISTINCT u2.name FROM users u2 WHERE u2.id = i.owner_id
                  OR u2.id IN (SELECT owner_id FROM idea_notes WHERE idea_id = i.id)
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
    const notes = await db.queryAll(
        `SELECT n.*, u.name AS owner_name FROM idea_notes n JOIN users u ON u.id = n.owner_id
         WHERE n.idea_id = $1 ORDER BY n.created_at`,
        [req.params.id as string],
    );
    const contributors = [...new Set([idea.owner_name, ...notes.map((n: any) => n.owner_name), ...votes.map((v: any) => v.name)])].slice(0, 5);
    const avg = votes.length ? votes.reduce((a: number, v: any) => a + v.feasibility, 0) / votes.length : null;
    const questions = await db.queryOne('SELECT count(*)::int AS c FROM questions WHERE idea_id = $1', [req.params.id as string]);
    res.json({
        ...idea, notes, votes, contributors,
        feasibility: avg !== null ? Math.round(avg * 10) / 10 : null,
        thoughts: notes.length + votes.length + (questions?.c ?? 0),
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

router.post('/:id/notes', withDatabase(async (req, res, _n, db) => {
    const b = validate(noteBody, req.body);
    const row = await db.queryOne(
        `INSERT INTO idea_notes (idea_id, owner_id, kind, body, parent_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.params.id as string, req.user!.id, b.kind, b.body, b.parent_id ?? null],
    );
    res.status(201).json(row);
}));

router.delete('/:id/notes/:noteId', withDatabase(async (req, res, _n, db) => {
    await db.query('DELETE FROM idea_notes WHERE id = $1 AND idea_id = $2', [
        req.params.noteId as string,
        req.params.id as string,
    ]);
    res.status(204).end();
}));

export default router;
