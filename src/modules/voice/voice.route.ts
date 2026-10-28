import { Router } from 'express';
import { AccessToken } from 'livekit-server-sdk';
import env from '@/shared/configs/env.js';
import withDatabase from '@/shared/utilities/with-database.js';

const router = Router();

// One global room: whoever is signed in and online can join it.
const ROOM = 'glob-live';

router.get('/token', withDatabase(async (req, res, _n, db) => {
    if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET || !env.LIVEKIT_URL) {
        res.status(503).json({ message: 'Voice is not configured' });
        return;
    }
    const me = await db.queryOne<{ id: string; name: string }>('SELECT id, name FROM users WHERE id = $1', [req.user!.id]);
    if (!me) {
        res.status(404).json({ message: 'User not found' });
        return;
    }
    const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
        identity: me.id,
        name: me.name,
        ttl: '2h',
    });
    at.addGrant({ room: ROOM, roomJoin: true, canPublish: true, canSubscribe: true });
    res.json({ url: env.LIVEKIT_URL, token: await at.toJwt() });
}));

export default router;
