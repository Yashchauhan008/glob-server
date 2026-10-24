import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import Database from '@/shared/helpers/database.helper.js';
import withDatabase from '@/shared/utilities/with-database.js';

const router = Router();

router.get('/', withDatabase(async (req, res, _n, db) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const before = typeof req.query.before === 'string' ? new Date(req.query.before) : null;
    const rows = await db.queryAll(
        `SELECT a.id, a.verb, a.entity_type, a.entity_id, a.title, a.detail, a.created_at, a.actor_id, u.name AS actor_name
         FROM activities a JOIN users u ON u.id = a.actor_id
         WHERE ($1::timestamptz IS NULL OR a.created_at < $1)
         ORDER BY a.created_at DESC LIMIT $2`,
        [before && !Number.isNaN(before.getTime()) ? before.toISOString() : null, limit],
    );
    res.json({ items: rows });
}));

export default router;

// ---- automatic logging of successful writes ----

type Entry = { verb: string; type: string; id: string | null; title: string; detail?: string | null };

const TABLES: Record<string, { table: string; col: string; label: string }> = {
    ideas: { table: 'ideas', col: 'title', label: 'idea' },
    todos: { table: 'todos', col: 'title', label: 'task' },
    events: { table: 'events', col: 'title', label: 'event' },
    questions: { table: 'questions', col: 'title', label: 'question' },
    products: { table: 'products', col: 'name', label: 'product' },
    leads: { table: 'leads', col: 'name', label: 'lead' },
};

const a = (w: string) => (/^[aeiou]/i.test(w) ? 'an ' : 'a ') + w;
const clip = (s: unknown, n = 140) => { const t = String(s ?? '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

async function lookupTitle(seg: string, id: string): Promise<string> {
    const t = TABLES[seg];
    if (!t || !/^[0-9a-f-]{36}$/i.test(id)) return '';
    const r = await Database.query(`SELECT ${t.col} AS title FROM ${t.table} WHERE id = $1`, [id]);
    return r.rows[0]?.title ?? '';
}

function describe(method: string, parts: string[], body: any, out: any, before: string): Entry | null {
    const [seg, id, sub, subId] = parts;
    const t = TABLES[seg];
    if (!t) return null;
    const title = clip(out?.title ?? out?.name ?? before);
    const eid = (out?.id as string | undefined) ?? id ?? null;

    if (method === 'POST' && !id) return { verb: `added ${a(t.label)}`, type: seg, id: eid, title };
    if (method === 'DELETE' && id && !sub) return { verb: `deleted ${a(t.label)}`, type: seg, id: null, title: before };

    if (seg === 'ideas' && id) {
        if (method === 'PUT' && sub === 'vote') return { verb: `rated feasibility ${body?.feasibility}/5 on`, type: seg, id, title: before };
        if (method === 'POST' && sub === 'notes') return { verb: `added a ${body?.kind ?? 'note'} to`, type: seg, id, title: before, detail: clip(body?.body) };
    }
    if (seg === 'questions' && id && method === 'POST') {
        if (sub === 'answers') return { verb: 'answered', type: seg, id, title: before, detail: clip(body?.body) };
        if (sub === 'accept') return { verb: 'accepted an answer on', type: seg, id, title: before };
    }
    if (seg === 'leads' && id && sub === 'activities' && method === 'POST')
        return { verb: `logged a ${body?.kind ?? 'note'} with`, type: seg, id, title: before, detail: clip(body?.body) };

    if (method === 'PATCH' && id) {
        if (seg === 'todos' && typeof body?.done === 'boolean') return { verb: body.done ? 'completed a task' : 'reopened a task', type: seg, id, title };
        if (body?.status) return { verb: `moved ${t.label} to ${body.status}`, type: seg, id, title };
        if (body?.stage) return { verb: `moved lead to ${body.stage}`, type: seg, id, title };
        return { verb: `edited ${a(t.label)}`, type: seg, id, title };
    }
    return null;
}

export async function activityLogger(req: Request, res: Response, next: NextFunction) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const parts = req.originalUrl.split('?')[0].split('/').filter(Boolean);
    if (!TABLES[parts[0]]) return next();

    // for deletes (and sub-resources) the title must be read before the handler changes things
    const before = parts[1] ? await lookupTitle(parts[0], parts[1]).catch(() => '') : '';
    let out: any;
    const json = res.json.bind(res);
    res.json = (b: any) => { out = b; return json(b); };

    res.on('finish', () => {
        if (res.statusCode >= 300 || !req.user) return;
        const e = describe(req.method, parts, req.body, out, before);
        if (!e) return;
        Database.query(
            'INSERT INTO activities (actor_id, verb, entity_type, entity_id, title, detail) VALUES ($1,$2,$3,$4,$5,$6)',
            [req.user.id, e.verb, e.type, e.id, e.title, e.detail ?? null],
        ).catch(() => {});
    });
    next();
}
