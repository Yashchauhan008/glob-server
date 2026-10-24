import { Router } from 'express';
import type { Response } from 'express';
import withDatabase from '@/shared/utilities/with-database.js';
import { parseCsv, toCsv } from '@/shared/utilities/csv.js';
import { STAGES } from '@/modules/leads/leads.route.js';
import { IDEA_STATUSES } from '@/modules/ideas/ideas.route.js';

const router = Router();

const send = (res: Response, name: string, csv: string) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    res.send(csv);
};

const exports_: Record<string, { sql: string; cols: string[] }> = {
    leads: {
        sql: 'SELECT * FROM leads ORDER BY created_at',
        cols: ['name', 'email', 'phone', 'company', 'source', 'stage', 'lost_reason', 'next_follow_up_at', 'address', 'latitude', 'longitude'],
    },
    ideas: { sql: 'SELECT * FROM ideas ORDER BY created_at', cols: ['title', 'description', 'status'] },
    notes: {
        sql: 'SELECT n.*, n.tag AS kind, i.title AS idea_title FROM idea_messages n JOIN ideas i ON i.id = n.idea_id ORDER BY n.created_at',
        cols: ['idea_title', 'kind', 'body'],
    },
    products: { sql: 'SELECT * FROM products ORDER BY created_at', cols: ['name', 'url', 'status'] },
    todos: { sql: 'SELECT * FROM todos ORDER BY created_at', cols: ['title', 'done', 'due_date'] },
};

router.get('/export/:entity', withDatabase(async (req, res, _n, db) => {
    const def = exports_[req.params.entity as string];
    if (!def) return res.status(404).json({ message: 'Unknown entity' });
    send(res, req.params.entity as string, toCsv(await db.queryAll(def.sql), def.cols));
}));

type RowError = { row: number; message: string };

router.post('/import/leads', withDatabase(async (req, res, _n, db) => {
    const rows = parseCsv(String(req.body?.csv ?? ''));
    const errors: RowError[] = [];
    let created = 0;
    let updated = 0;
    for (const [idx, r] of rows.entries()) {
        const n = idx + 2; // header is line 1
        if (!r.name) { errors.push({ row: n, message: 'name is required' }); continue; }
        const stage = (r.stage || 'new').toLowerCase();
        if (!(STAGES as readonly string[]).includes(stage)) { errors.push({ row: n, message: `unknown stage "${r.stage}"` }); continue; }
        const lat = r.latitude === '' || r.latitude === undefined ? null : Number(r.latitude);
        const lng = r.longitude === '' || r.longitude === undefined ? null : Number(r.longitude);
        if ((lat !== null && (Number.isNaN(lat) || lat < -90 || lat > 90)) ||
            (lng !== null && (Number.isNaN(lng) || lng < -180 || lng > 180)) ||
            ((lat === null) !== (lng === null))) {
            errors.push({ row: n, message: 'invalid latitude/longitude' }); continue;
        }
        const email = r.email ? r.email.toLowerCase() : null;
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { errors.push({ row: n, message: 'invalid email' }); continue; }
        const follow = r.next_follow_up_at ? new Date(r.next_follow_up_at) : null;
        if (follow && Number.isNaN(follow.getTime())) { errors.push({ row: n, message: 'invalid next_follow_up_at' }); continue; }

        const vals = [req.user!.id, r.name, email, r.phone || null, r.company || null, r.source || null, stage,
            stage === 'lost' ? r.lost_reason || null : null, follow, r.address || null, lat, lng,
            stage === 'won' || stage === 'lost' ? new Date() : null];
        const closes = vals[12] !== null;
        const existing = email ? await db.queryOne('SELECT id FROM leads WHERE lower(email) = $1', [email]) : null;
        if (existing) {
            await db.query(
                `UPDATE leads SET name=$2, phone=$3, company=$4, source=$5, stage=$6, lost_reason=$7,
                    next_follow_up_at=$8, address=$9, latitude=$10, longitude=$11, updated_at=now(),
                    closed_at = CASE WHEN $12::boolean THEN coalesce(closed_at, now()) END
                 WHERE id = $1`,
                [existing.id, r.name, vals[3], vals[4], vals[5], stage, vals[7], follow, vals[9], lat, lng, closes] as any[],
            );
            updated++;
        } else {
            await db.query(
                `INSERT INTO leads (owner_id,name,email,phone,company,source,stage,lost_reason,
                    next_follow_up_at,address,latitude,longitude,closed_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
                vals as any[],
            );
            created++;
        }
    }
    res.json({ created, updated, errors });
}));

router.post('/import/ideas', withDatabase(async (req, res, _n, db) => {
    const rows = parseCsv(String(req.body?.csv ?? ''));
    const errors: RowError[] = [];
    let created = 0;
    for (const [idx, r] of rows.entries()) {
        const status = (r.status || 'idea').toLowerCase();
        if (!r.title) { errors.push({ row: idx + 2, message: 'title is required' }); continue; }
        if (!(IDEA_STATUSES as readonly string[]).includes(status)) { errors.push({ row: idx + 2, message: `unknown status "${r.status}"` }); continue; }
        await db.query('INSERT INTO ideas (owner_id,title,description,status) VALUES ($1,$2,$3,$4)',
            [req.user!.id, r.title, r.description || '', status]);
        created++;
    }
    res.json({ created, updated: 0, errors });
}));

router.post('/import/todos', withDatabase(async (req, res, _n, db) => {
    const rows = parseCsv(String(req.body?.csv ?? ''));
    const errors: RowError[] = [];
    let created = 0;
    for (const [idx, r] of rows.entries()) {
        if (!r.title) { errors.push({ row: idx + 2, message: 'title is required' }); continue; }
        if (r.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(r.due_date)) { errors.push({ row: idx + 2, message: 'due_date must be YYYY-MM-DD' }); continue; }
        await db.query('INSERT INTO todos (owner_id,title,done,due_date) VALUES ($1,$2,$3,$4)',
            [req.user!.id, r.title, ['true', '1', 'yes'].includes((r.done || '').toLowerCase()), r.due_date || null]);
        created++;
    }
    res.json({ created, updated: 0, errors });
}));

export default router;
