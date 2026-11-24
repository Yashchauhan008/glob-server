import { Router } from 'express';
import z from 'zod';
import withDatabase from '@/shared/utilities/with-database.js';
import { validate } from '@/shared/helpers/validation.helper.js';
import Database from '@/shared/helpers/database.helper.js';
import { CallError, activeCalls, declineCall, joinCall, leaveCall, startCall } from '@/modules/calls/calls.service.js';

const router = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const startBody = z.object({
    scope: z.enum(['dm', 'group']),
    kind: z.enum(['voice', 'video']),
    to: z.string().uuid().optional(),
    user_ids: z.array(z.string().uuid()).max(200).optional(),
    all: z.boolean().optional(),
});

const me = async (id: string) => {
    const u = await Database.queryOne<{ id: string; name: string }>('SELECT id, name FROM users WHERE id = $1', [id]);
    if (!u) throw new CallError('User not found', 404);
    return u;
};

const fail = (res: any, e: unknown) => {
    if (e instanceof CallError) return res.status(e.status).json({ message: e.message });
    return res.status(400).json({ message: (e as Error).message || 'Call failed' });
};

// calls still going on in this workspace (the "call in progress" banner, and ringing calls you may have missed the push for)
router.get('/active', withDatabase(async (req, res) => {
    res.json({ items: await activeCalls(req.team!.id, req.user!.id) });
}));

router.post('/', withDatabase(async (req, res) => {
    try {
        const b = validate(startBody, req.body);
        res.status(201).json(await startCall(await me(req.user!.id), req.team!.id, b));
    } catch (e) { fail(res, e); }
}));

router.post('/:id/join', withDatabase(async (req, res) => {
    try {
        if (!UUID.test(String(req.params.id))) throw new CallError('Call not found', 404);
        res.json(await joinCall(await me(req.user!.id), req.team!.id, req.params.id as string));
    } catch (e) { fail(res, e); }
}));
// answering is the same thing as joining
router.post('/:id/accept', withDatabase(async (req, res) => {
    try {
        if (!UUID.test(String(req.params.id))) throw new CallError('Call not found', 404);
        res.json(await joinCall(await me(req.user!.id), req.team!.id, req.params.id as string));
    } catch (e) { fail(res, e); }
}));

router.post('/:id/decline', withDatabase(async (req, res) => {
    try {
        if (!UUID.test(String(req.params.id))) throw new CallError('Call not found', 404);
        await declineCall(await me(req.user!.id), req.team!.id, req.params.id as string);
        res.status(204).end();
    } catch (e) { fail(res, e); }
}));

router.post('/:id/leave', withDatabase(async (req, res) => {
    try {
        if (!UUID.test(String(req.params.id))) throw new CallError('Call not found', 404);
        await leaveCall(await me(req.user!.id), req.team!.id, req.params.id as string);
        res.status(204).end();
    } catch (e) { fail(res, e); }
}));

export default router;
