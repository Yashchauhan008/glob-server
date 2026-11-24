import { Router } from 'express';
import z from 'zod';
import withDatabase from '@/shared/utilities/with-database.js';
import { validate } from '@/shared/helpers/validation.helper.js';

const router = Router();

// everything that needs this person's attention, across all their workspaces
router.get('/', withDatabase(async (req, res, _n, db) => {
    const items = await db.queryAll(
        `SELECT n.id, n.team_id, t.name AS team_name, n.type, n.label, n.title, n.body, n.data, n.created_at, n.read_at
         FROM notifications n LEFT JOIN teams t ON t.id = n.team_id
         WHERE n.user_id = $1 ORDER BY n.created_at DESC LIMIT 100`,
        [req.user!.id],
    );
    const unread = await db.queryOne<{ n: number }>('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.user!.id]);
    res.json({ items, unread: unread?.n ?? 0 });
}));

router.post('/read', withDatabase(async (req, res, _n, db) => {
    const b = validate(z.object({ ids: z.array(z.string().uuid()).max(200).optional() }), req.body);
    if (b.ids?.length) await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL', [req.user!.id, b.ids]);
    else await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user!.id]);
    res.status(204).end();
}));

router.delete('/', withDatabase(async (req, res, _n, db) => {
    await db.query('DELETE FROM notifications WHERE user_id = $1', [req.user!.id]);
    res.status(204).end();
}));

// a phone registers (or refreshes) its push token
router.post('/devices', withDatabase(async (req, res, _n, db) => {
    const b = validate(z.object({ token: z.string().trim().min(20).max(4096), platform: z.string().trim().max(20).default('android') }), req.body);
    await db.query(
        `INSERT INTO device_tokens (token, user_id, platform) VALUES ($1,$2,$3)
         ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, updated_at = now()`,
        [b.token, req.user!.id, b.platform],
    );
    res.status(204).end();
}));

router.post('/devices/remove', withDatabase(async (req, res, _n, db) => {
    const b = validate(z.object({ token: z.string().trim().min(1).max(4096) }), req.body);
    await db.query('DELETE FROM device_tokens WHERE token = $1 AND user_id = $2', [b.token, req.user!.id]);
    res.status(204).end();
}));

export default router;
