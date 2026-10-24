import { Router } from 'express';
import z from 'zod';
import withDatabase from '@/shared/utilities/with-database.js';
import { validate } from '@/shared/helpers/validation.helper.js';
import { patchRow, notFound } from '@/shared/utilities/crud.js';

const body = z.object({
    title: z.string().trim().min(1).max(500),
    done: z.boolean().default(false),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    idea_id: z.string().uuid().nullish(),
    note_id: z.string().uuid().nullish(),
    product_id: z.string().uuid().nullish(),
    lead_id: z.string().uuid().nullish(),
});
const patch = body.partial();

const router = Router();

router.get('/', withDatabase(async (req, res, _n, db) => {
    const filter = String(req.query.filter || 'all');
    const where = filter === 'open' ? 'WHERE t.done = false' : filter === 'done' ? 'WHERE t.done = true' : '';
    const items = await db.queryAll(
        `SELECT t.*, i.title AS idea_title, p.name AS product_name, l.name AS lead_name
         FROM todos t
         LEFT JOIN ideas i ON i.id = t.idea_id
         LEFT JOIN products p ON p.id = t.product_id
         LEFT JOIN leads l ON l.id = t.lead_id
         ${where} ORDER BY t.done, t.due_date NULLS LAST, t.created_at DESC`,
    );
    // lead follow-ups surface here too (read-only virtual items)
    const followUps = filter === 'done' ? [] : await db.queryAll(
        `SELECT id AS lead_id, name AS lead_name, next_follow_up_at
         FROM leads WHERE next_follow_up_at IS NOT NULL AND stage NOT IN ('won','lost')
         ORDER BY next_follow_up_at`,
    );
    res.json({ items, follow_ups: followUps });
}));

router.post('/', withDatabase(async (req, res, _n, db) => {
    const b = validate(body, req.body);
    res.status(201).json(
        await db.queryOne(
            `INSERT INTO todos (owner_id, title, done, due_date, idea_id, note_id, product_id, lead_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [req.user!.id, b.title, b.done, b.due_date ?? null, b.idea_id ?? null, b.note_id ?? null,
             b.product_id ?? null, b.lead_id ?? null],
        ),
    );
}));

router.patch('/:id', withDatabase(async (req, res, _n, db) => {
    const row = await patchRow(db, 'todos', req.params.id as string, validate(patch, req.body));
    if (!row) return notFound(res);
    res.json(row);
}));

router.delete('/:id', withDatabase(async (req, res, _n, db) => {
    await db.query('DELETE FROM todos WHERE id = $1', [req.params.id as string]);
    res.status(204).end();
}));

export default router;
