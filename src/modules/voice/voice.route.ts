import { Router } from 'express';
import { AccessToken, RoomServiceClient, TrackType } from 'livekit-server-sdk';
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

// Who is in the call right now and since when, so the pill can show it before you join.
router.get('/status', async (_req, res) => {
    const empty = { active: false, startedAt: null as number | null, participants: [] as { id: string; name: string }[], video: false };
    if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET || !env.LIVEKIT_URL) {
        res.json(empty);
        return;
    }
    try {
        const api = new RoomServiceClient(env.LIVEKIT_URL.replace(/^ws/, 'http'), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
        const [room] = await api.listRooms([ROOM]);
        if (!room || room.numParticipants === 0) {
            res.json(empty);
            return;
        }
        const people = await api.listParticipants(ROOM);
        res.json({
            active: true,
            startedAt: Number(room.creationTime) * 1000,
            participants: people.map((p) => ({ id: p.identity, name: p.name || 'Guest' })),
            video: people.some((p) => p.tracks.some((t) => t.type === TrackType.VIDEO && !t.muted)),
        });
    } catch {
        res.json(empty);
    }
});

export default router;
