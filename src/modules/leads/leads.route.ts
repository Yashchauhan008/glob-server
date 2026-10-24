import { Router } from 'express';
import z from 'zod';
import withDatabase from '@/shared/utilities/with-database.js';
import { validate } from '@/shared/helpers/validation.helper.js';
import { patchRow, notFound } from '@/shared/utilities/crud.js';

export const STAGES = ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const;
const KINDS = ['call', 'email', 'meeting', 'note', 'stage_change'] as const;

const opt = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);

const body = z.object({
    name: z.string().trim().min(1).max(255),
    email: z.string().trim().toLowerCase().email().max(255).nullish().or(z.literal('')).transform((v) => v || null),
    phone: opt(50),
    company: opt(255),
    source: opt(255),
    stage: z.enum(STAGES).default('new'),
    lost_reason: opt(2000),
    next_follow_up_at: z.string().datetime({ offset: true }).nullish(),
    address: opt(500),
    latitude: z.coerce.number().min(-90).max(90).nullish(),
    longitude: z.coerce.number().min(-180).max(180).nullish(),
});
const patch = body.partial();
const activityBody = z.object({
    kind: z.enum(KINDS).default('note'),
    body: z.string().trim().max(10000).default(''),
});

const router = Router();

router.get('/', withDatabase(async (_req, res, _n, db) => {
    res.json({
        items: await db.queryAll(
            `SELECT l.*, u.name AS owner_name FROM leads l JOIN users u ON u.id = l.owner_id
             ORDER BY l.created_at DESC`,
        ),
    });
}));

router.post('/', withDatabase(async (req, res, _n, db) => {
    const b = validate(body, req.body);
    const row = await db.queryOne(
        `INSERT INTO leads (owner_id, name, email, phone, company, source, stage, lost_reason,
            next_follow_up_at, address, latitude, longitude, closed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [req.user!.id, b.name, b.email, b.phone, b.company, b.source, b.stage, b.lost_reason,
         b.next_follow_up_at ?? null, b.address, b.latitude ?? null, b.longitude ?? null,
         b.stage === 'won' || b.stage === 'lost' ? new Date() : null],
    );
    res.status(201).json(row);
}));

router.get('/:id', withDatabase(async (req, res, _n, db) => {
    const lead = await db.queryOne('SELECT * FROM leads WHERE id = $1', [req.params.id as string]);
    if (!lead) return notFound(res);
    const activities = await db.queryAll(
        `SELECT a.*, u.name AS owner_name FROM lead_activities a JOIN users u ON u.id = a.owner_id
         WHERE a.lead_id = $1 ORDER BY a.created_at DESC`,
        [req.params.id as string],
    );
    res.json({ ...lead, activities });
}));

router.patch('/:id', withDatabase(async (req, res, _n, db) => {
    const id = req.params.id as string;
    const data = validate(patch, req.body) as Record<string, unknown>;
    const before = await db.queryOne('SELECT stage FROM leads WHERE id = $1', [id]);
    if (!before) return notFound(res);
    if (data.stage && data.stage !== before.stage) {
        data.closed_at = data.stage === 'won' || data.stage === 'lost' ? new Date() : null;
        if (data.stage !== 'lost') data.lost_reason = null;
    }
    const row = await patchRow(db, 'leads', id, data);
    if (data.stage && data.stage !== before.stage) {
        await db.query(
            "INSERT INTO lead_activities (lead_id, owner_id, kind, body) VALUES ($1,$2,'stage_change',$3)",
            [id, req.user!.id, `${before.stage} → ${data.stage}`],
        );
    }
    res.json(row);
}));

router.delete('/:id', withDatabase(async (req, res, _n, db) => {
    await db.query('DELETE FROM leads WHERE id = $1', [req.params.id as string]);
    res.status(204).end();
}));

router.post('/:id/activities', withDatabase(async (req, res, _n, db) => {
    const b = validate(activityBody, req.body);
    res.status(201).json(
        await db.queryOne(
            'INSERT INTO lead_activities (lead_id, owner_id, kind, body) VALUES ($1,$2,$3,$4) RETURNING *',
            [req.params.id as string, req.user!.id, b.kind, b.body],
        ),
    );
}));

export default router;
