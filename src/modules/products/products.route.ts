import { Router } from 'express';
import z from 'zod';
import withDatabase from '@/shared/utilities/with-database.js';
import { validate } from '@/shared/helpers/validation.helper.js';
import { patchRow, notFound } from '@/shared/utilities/crud.js';
import { foreignLink, inTeam, linksInTeam } from '@/modules/teams/team.scope.js';

const body = z.object({
    name: z.string().trim().min(1).max(255),
    url: z.string().trim().max(2000).default(''),
    description: z.string().trim().max(10000).default(''),
    status: z.enum(['up', 'down', 'building']).default('building'),
    idea_id: z.string().uuid().nullish(),
});
const patch = body.partial();

const router = Router();
router.param('id', inTeam('products'));

router.get('/', withDatabase(async (req, res, _n, db) => {
    res.json({
        items: await db.queryAll(
            `SELECT p.*, i.title AS idea_title FROM products p
             LEFT JOIN ideas i ON i.id = p.idea_id WHERE p.team_id = $1 ORDER BY p.created_at DESC`,
            [req.team!.id],
        ),
    });
}));

router.post('/', withDatabase(async (req, res, _n, db) => {
    const b = validate(body, req.body);
    if (!(await linksInTeam(req.team!.id, { ideas: b.idea_id }))) return foreignLink(res);
    res.status(201).json(
        await db.queryOne(
            'INSERT INTO products (owner_id, name, url, description, status, idea_id, team_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
            [req.user!.id, b.name, b.url, b.description, b.status, b.idea_id ?? null, req.team!.id],
        ),
    );
}));

router.patch('/:id', withDatabase(async (req, res, _n, db) => {
    const data = validate(patch, req.body);
    if (!(await linksInTeam(req.team!.id, { ideas: data.idea_id }))) return foreignLink(res);
    const row = await patchRow(db, 'products', req.params.id as string, data);
    if (!row) return notFound(res);
    res.json(row);
}));

router.delete('/:id', withDatabase(async (req, res, _n, db) => {
    await db.query('DELETE FROM products WHERE id = $1', [req.params.id as string]);
    res.status(204).end();
}));

export default router;
