import { Router } from 'express';
import z from 'zod';
import withDatabase from '@/shared/utilities/with-database.js';
import { validate } from '@/shared/helpers/validation.helper.js';
import { patchRow, notFound } from '@/shared/utilities/crud.js';

const body = z.object({
    title: z.string().trim().min(1).max(255),
    kind: z.enum(['meeting', 'appointment', 'task', 'reminder']).default('meeting'),
    starts_at: z.string().datetime({ offset: true }),
    ends_at: z.string().datetime({ offset: true }).nullish(),
    notes: z.string().trim().max(5000).default(''),
    idea_id: z.string().uuid().nullish(),
    lead_id: z.string().uuid().nullish(),
});
const patch = body.partial();
const router = Router();

router.get('/', withDatabase(async (req, res, _n, db) => {
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 86400000);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now() + 30 * 86400000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return res.status(400).json({ message: 'Bad date range' });
    const items = await db.queryAll(
        `SELECT e.*, u.name AS owner_name, i.title AS idea_title, l.name AS lead_name
         FROM events e JOIN users u ON u.id = e.owner_id
         LEFT JOIN ideas i ON i.id = e.idea_id LEFT JOIN leads l ON l.id = e.lead_id
         WHERE e.starts_at >= $1 AND e.starts_at < $2 ORDER BY e.starts_at`,
        [from, to],
    );
    res.json({ items });
}));

router.post('/', withDatabase(async (req, res, _n, db) => {
    const b = validate(body, req.body);
    res.status(201).json(await db.queryOne(
        `INSERT INTO events (owner_id,title,kind,starts_at,ends_at,notes,idea_id,lead_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [req.user!.id, b.title, b.kind, b.starts_at, b.ends_at ?? null, b.notes, b.idea_id ?? null, b.lead_id ?? null],
    ));
}));

router.patch('/:id', withDatabase(async (req, res, _n, db) => {
    const row = await patchRow(db, 'events', req.params.id as string, validate(patch, req.body));
    if (!row) return notFound(res);
    res.json(row);
}));

router.delete('/:id', withDatabase(async (req, res, _n, db) => {
    await db.query('DELETE FROM events WHERE id = $1', [req.params.id as string]);
    res.status(204).end();
}));

export default router;
