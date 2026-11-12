import { Router } from 'express';
import z from 'zod';
import withDatabase from '@/shared/utilities/with-database.js';
import { validate } from '@/shared/helpers/validation.helper.js';
import { notFound } from '@/shared/utilities/crud.js';

export const DEFAULT_TAGS = ['visited', 'next meet point', 'good place'];

const tag = z.string().trim().toLowerCase().min(1).max(40);
const body = z.object({
    title: z.string().trim().min(1).max(200),
    note: z.string().trim().max(2000).default(''),
    tag: tag.default('saved'),
    address: z.string().trim().max(500).default(''),
    latitude: z.coerce.number().min(-90).max(90),
    longitude: z.coerce.number().min(-180).max(180),
});
const patch = body.partial();

/**
 * Map pins. "team" pins belong to the team in the X-Team-Id header and everyone in it sees them;
 * "personal" pins have no team and are only ever shown to the person who made them.
 */
export function makePinsRouter(scope: 'team' | 'personal') {
    const router = Router();
    // SQL fragment + parameters that pick out the pins this request may see ($1 is always the owner, $2 the team)
    const where = (req: { user?: { id: string }; team?: { id: string } }) =>
        scope === 'team'
            ? { sql: 'team_id = $1', params: [req.team!.id] as string[] }
            : { sql: 'team_id IS NULL AND owner_id = $1', params: [req.user!.id] as string[] };
    const teamId = (req: { team?: { id: string } }) => (scope === 'team' ? req.team!.id : null);

    router.get('/', withDatabase(async (req, res, _n, db) => {
        const w = where(req);
        res.json({
            items: await db.queryAll(
                `SELECT p.*, u.name AS owner_name FROM pins p JOIN users u ON u.id = p.owner_id WHERE p.${w.sql} ORDER BY p.created_at DESC`,
                w.params,
            ),
        });
    }));

    /** Tags already used here, most used first, with the starter tags always on offer. */
    router.get('/tags', withDatabase(async (req, res, _n, db) => {
        const w = where(req);
        const used = await db.queryAll(`SELECT tag, count(*)::int AS n FROM pins WHERE ${w.sql} GROUP BY tag ORDER BY n DESC, tag`, w.params);
        const names = used.map((r) => r.tag as string);
        res.json({ items: [...names, ...DEFAULT_TAGS.filter((t) => !names.includes(t))] });
    }));

    router.post('/', withDatabase(async (req, res, _n, db) => {
        const b = validate(body, req.body);
        const row = await db.queryOne(
            `INSERT INTO pins (team_id, owner_id, title, note, tag, address, latitude, longitude)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [teamId(req), req.user!.id, b.title, b.note, b.tag, b.address, b.latitude, b.longitude],
        );
        res.status(201).json(row);
    }));

    router.patch('/:id', withDatabase(async (req, res, _n, db) => {
        const data = validate(patch, req.body) as Record<string, unknown>;
        const w = where(req);
        const keys = Object.keys(data).filter((k) => data[k] !== undefined);
        const id = req.params.id as string;
        if (!keys.length) return res.json(await db.queryOne(`SELECT * FROM pins WHERE id = $2 AND ${w.sql}`, [...w.params, id]));
        const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
        // only the person who dropped a pin (or a team owner) can change it
        const mine = scope === 'team' && req.team!.role === 'owner' ? '' : ' AND owner_id = $' + (keys.length + 3);
        const row = await db.queryOne(
            `UPDATE pins SET ${sets}, updated_at = now() WHERE id = $2 AND ${w.sql}${mine} RETURNING *`,
            [...w.params, id, ...keys.map((k) => data[k]), ...(mine ? [req.user!.id] : [])] as (string | number)[],
        );
        if (!row) return notFound(res);
        res.json(row);
    }));

    router.delete('/:id', withDatabase(async (req, res, _n, db) => {
        const w = where(req);
        const owner = scope === 'team' && req.team!.role === 'owner';
        await db.query(
            `DELETE FROM pins WHERE id = $2 AND ${w.sql}${owner ? '' : ' AND owner_id = $3'}`,
            [...w.params, req.params.id as string, ...(owner ? [] : [req.user!.id])],
        );
        res.status(204).end();
    }));

    return router;
}
