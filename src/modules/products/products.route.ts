import { Router } from 'express';
import z from 'zod';
import withDatabase from '@/shared/utilities/with-database.js';
import { validate } from '@/shared/helpers/validation.helper.js';
import { patchRow, notFound } from '@/shared/utilities/crud.js';

const body = z.object({
    name: z.string().trim().min(1).max(255),
    url: z.string().trim().max(2000).default(''),
    description: z.string().trim().max(10000).default(''),
    status: z.enum(['up', 'down', 'building']).default('building'),
    idea_id: z.string().uuid().nullish(),
});
const patch = body.partial();

const router = Router();

router.get('/', withDatabase(async (_req, res, _n, db) => {
    res.json({
        items: await db.queryAll(
            `SELECT p.*, i.title AS idea_title FROM products p
             LEFT JOIN ideas i ON i.id = p.idea_id ORDER BY p.created_at DESC`,
        ),
    });
}));

router.post('/', withDatabase(async (req, res, _n, db) => {
    const b = validate(body, req.body);
    res.status(201).json(
        await db.queryOne(
            'INSERT INTO products (owner_id, name, url, description, status, idea_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
            [req.user!.id, b.name, b.url, b.description, b.status, b.idea_id ?? null],
        ),
    );
}));

router.patch('/:id', withDatabase(async (req, res, _n, db) => {
    const row = await patchRow(db, 'products', req.params.id as string, validate(patch, req.body));
    if (!row) return notFound(res);
    res.json(row);
}));

router.delete('/:id', withDatabase(async (req, res, _n, db) => {
    await db.query('DELETE FROM products WHERE id = $1', [req.params.id as string]);
    res.status(204).end();
}));

export default router;
