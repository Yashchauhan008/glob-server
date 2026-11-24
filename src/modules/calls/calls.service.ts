import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import env from '@/shared/configs/env.js';
import Logger from '@/shared/configs/logger.js';
import Database from '@/shared/helpers/database.helper.js';
import SocketService from '@/socket.js';
import { roleIn, teamRoom, userRoom } from '@/modules/teams/team.service.js';
import { notifyUser } from '@/modules/notifications/notify.service.js';
import { sendPush } from '@/modules/notifications/fcm.js';
import { postCallMessage } from '@/modules/messaging/messaging.service.js';

export const RING_MS = 30_000;

export type CallKind = 'voice' | 'video';
export type CallScope = 'dm' | 'group';
type Who = { id: string; name: string };

export class CallError extends Error {
    status: number;
    constructor(message: string, status = 400) {
        super(message);
        this.status = status;
    }
}

const ringTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ------------------------------------------------------------------ reading

export async function callView(id: string) {
    const c = await Database.queryOne(
        `SELECT id, team_id, kind, scope, initiator_id, room, started_at, answered_at, ended_at, end_reason FROM calls WHERE id = $1`,
        [id],
    );
    if (!c) return null;
    const participants = await Database.queryAll<{ user_id: string; name: string; avatar_url: string | null; state: string }>(
        `SELECT p.user_id, u.name, u.avatar_url, p.state
         FROM call_participants p JOIN users u ON u.id = p.user_id
         WHERE p.call_id = $1 ORDER BY p.invited_at`,
        [id],
    );
    const joined = participants.filter((p) => p.state === 'joined').length;
    const ringing = participants.some((p) => p.state === 'ringing');
    const status = c.ended_at ? 'ended' : ringing && joined <= 1 ? 'ringing' : 'active';
    return { ...c, status, participants };
}
type CallViewT = NonNullable<Awaited<ReturnType<typeof callView>>>;

/** Calls that are still going on in a workspace, and that this person may see (their own, or any group call). */
export async function activeCalls(teamId: string, userId: string) {
    const rows = await Database.queryAll<{ id: string }>(
        `SELECT c.id FROM calls c
         WHERE c.team_id = $1 AND c.ended_at IS NULL
           AND (c.scope = 'group' OR EXISTS (SELECT 1 FROM call_participants p WHERE p.call_id = c.id AND p.user_id = $2))
         ORDER BY c.started_at DESC`,
        [teamId, userId],
    );
    const out: CallViewT[] = [];
    for (const r of rows) { const v = await callView(r.id); if (v) out.push(v); }
    return out;
}

/** Tell everyone who should know that the call changed. Group calls also go to the whole workspace (the "in progress" banner). */
async function broadcast(callId: string) {
    const v = await callView(callId);
    const io = SocketService.io;
    if (!v || !io) return v;
    const rooms = v.participants.map((p) => userRoom(v.team_id, p.user_id));
    io.to(v.scope === 'group' ? [teamRoom(v.team_id), ...rooms] : rooms).emit('call:state', v);
    return v;
}

async function liveToken(callRoom: string, who: Who) {
    if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET || !env.LIVEKIT_URL) throw new CallError('Calls are not configured', 503);
    const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, { identity: who.id, name: who.name, ttl: '6h' });
    at.addGrant({ room: callRoom, roomJoin: true, canPublish: true, canPublishData: true, canSubscribe: true, canUpdateOwnMetadata: true });
    return { url: env.LIVEKIT_URL, token: await at.toJwt(), room: callRoom };
}

const userById = (id: string) =>
    Database.queryOne<{ id: string; name: string; avatar_url: string | null }>('SELECT id, name, avatar_url FROM users WHERE id = $1', [id]);

async function inAnotherCall(userId: string) {
    return !!(await Database.queryOne(
        `SELECT 1 AS ok FROM call_participants p JOIN calls c ON c.id = p.call_id
         WHERE p.user_id = $1 AND p.state = 'joined' AND c.ended_at IS NULL`,
        [userId],
    ));
}

// ------------------------------------------------------------------ starting

export async function startCall(
    who: Who,
    teamId: string,
    input: { scope: CallScope; kind: CallKind; to?: string; user_ids?: string[]; all?: boolean },
) {
    await expireStale();
    if (await inAnotherCall(who.id)) throw new CallError('You are already in a call', 409);

    let invitees: string[] = [];
    if (input.scope === 'dm') {
        if (!input.to || input.to === who.id) throw new CallError('Choose who to call');
        if (!(await roleIn(input.to, teamId))) throw new CallError('That person is not in this workspace', 404);
        invitees = [input.to];
    } else if (input.all) {
        const m = await Database.queryAll<{ user_id: string }>(
            `SELECT m.user_id FROM team_members m JOIN users u ON u.id = m.user_id
             WHERE m.team_id = $1 AND m.user_id <> $2 AND u.blocked_at IS NULL`,
            [teamId, who.id],
        );
        invitees = m.map((x) => x.user_id);
    } else {
        for (const id of [...new Set(input.user_ids ?? [])]) {
            if (id !== who.id && (await roleIn(id, teamId))) invitees.push(id);
        }
    }

    const call = await Database.queryOne<{ id: string }>(
        `INSERT INTO calls (team_id, kind, scope, initiator_id, room) VALUES ($1,$2,$3,$4, 'pending') RETURNING id`,
        [teamId, input.kind, input.scope, who.id],
    );
    if (!call) throw new CallError('Could not start the call', 500);
    const room = `call-${call.id}`;
    await Database.query('UPDATE calls SET room = $2 WHERE id = $1', [call.id, room]);
    await Database.query(`INSERT INTO call_participants (call_id, user_id, state, joined_at) VALUES ($1,$2,'joined', now())`, [call.id, who.id]);

    const ringNow: string[] = [];
    for (const id of invitees) {
        const busy = await inAnotherCall(id);
        await Database.query(`INSERT INTO call_participants (call_id, user_id, state) VALUES ($1,$2,$3)`, [call.id, id, busy ? 'busy' : 'ringing']);
        if (!busy) ringNow.push(id);
    }

    // a one-to-one call where the other person is busy ends at once
    if (input.scope === 'dm' && !ringNow.length) {
        await endCall(call.id, 'busy');
        throw new CallError('They are on another call', 409);
    }

    const me = await userById(who.id);
    const team = await Database.queryOne<{ name: string }>('SELECT name FROM teams WHERE id = $1', [teamId]);
    const view = await broadcast(call.id);
    for (const id of ringNow) {
        SocketService.io?.to(userRoom(teamId, id)).emit('call:incoming', { call: view, from: { id: who.id, name: who.name, avatar_url: me?.avatar_url ?? null } });
        void sendPush(id, {
            title: who.name,
            body: `Incoming ${input.kind} call`,
            channel: 'call',
            ttlSeconds: 30,
            data: {
                type: 'call_incoming', call_id: call.id, kind: input.kind, scope: input.scope, team_id: teamId,
                team_name: team?.name ?? '', from_id: who.id, from_name: who.name, from_avatar: me?.avatar_url ?? '',
            },
        });
    }
    if (ringNow.length) ringTimers.set(call.id, setTimeout(() => { void expireRinging(call.id).catch(() => {}); }, RING_MS));
    ensureReconciler();

    return { call: view, token: await liveToken(room, who) };
}

// ------------------------------------------------------------------ answering

async function loadOpenCall(callId: string, teamId: string) {
    const c = await Database.queryOne<{ id: string; team_id: string; room: string; scope: CallScope; kind: CallKind; initiator_id: string; ended_at: string | null }>(
        'SELECT id, team_id, room, scope, kind, initiator_id, ended_at FROM calls WHERE id = $1 AND team_id = $2',
        [callId, teamId],
    );
    if (!c) throw new CallError('Call not found', 404);
    if (c.ended_at) throw new CallError('This call has ended', 410);
    return c;
}

/** The person answered a ringing call, or joined a group call that is in progress. */
export async function joinCall(who: Who, teamId: string, callId: string) {
    const c = await loadOpenCall(callId, teamId);
    const mine = await Database.queryOne<{ state: string }>('SELECT state FROM call_participants WHERE call_id = $1 AND user_id = $2', [callId, who.id]);
    if (!mine && c.scope === 'dm') throw new CallError('Call not found', 404);
    if (mine?.state === 'joined') return { call: await callView(callId), token: await liveToken(c.room, who) };
    if (await inAnotherCall(who.id)) throw new CallError('You are already in a call', 409);

    await Database.query(
        `INSERT INTO call_participants (call_id, user_id, state, joined_at) VALUES ($1,$2,'joined', now())
         ON CONFLICT (call_id, user_id) DO UPDATE SET state = 'joined', joined_at = now(), left_at = NULL`,
        [callId, who.id],
    );
    await Database.query('UPDATE calls SET answered_at = coalesce(answered_at, now()) WHERE id = $1', [callId]);
    // the person's other phones and tabs stop ringing
    SocketService.io?.to(userRoom(teamId, who.id)).emit('call:handled', { call_id: callId });
    void sendPush(who.id, { title: '', body: '', channel: 'call', ttlSeconds: 30, data: { type: 'call_cancel', call_id: callId } });
    await maybeStopRinging(callId);
    const view = await broadcast(callId);
    return { call: view, token: await liveToken(c.room, who) };
}

export async function declineCall(who: Who, teamId: string, callId: string) {
    const c = await loadOpenCall(callId, teamId);
    await Database.query(`UPDATE call_participants SET state = 'declined', left_at = now() WHERE call_id = $1 AND user_id = $2 AND state = 'ringing'`, [callId, who.id]);
    SocketService.io?.to(userRoom(teamId, who.id)).emit('call:handled', { call_id: callId });
    void sendPush(who.id, { title: '', body: '', channel: 'call', ttlSeconds: 30, data: { type: 'call_cancel', call_id: callId } });
    if (c.scope === 'dm') await endCall(callId, 'declined');
    else {
        await maybeStopRinging(callId);
        await broadcast(callId);
    }
}

export async function leaveCall(who: Who, teamId: string, callId: string) {
    const c = await Database.queryOne<{ id: string; scope: CallScope; ended_at: string | null }>(
        'SELECT id, scope, ended_at FROM calls WHERE id = $1 AND team_id = $2', [callId, teamId]);
    if (!c || c.ended_at) return;
    await Database.query(`UPDATE call_participants SET state = 'left', left_at = now() WHERE call_id = $1 AND user_id = $2 AND state IN ('joined', 'ringing')`, [callId, who.id]);
    await afterLeave(callId, c.scope);
}

async function afterLeave(callId: string, scope: CallScope) {
    const left = await Database.queryOne<{ joined: number; ringing: number }>(
        `SELECT count(*) FILTER (WHERE state = 'joined')::int AS joined, count(*) FILTER (WHERE state = 'ringing')::int AS ringing
         FROM call_participants WHERE call_id = $1`, [callId]);
    // a one-to-one call ends when either side hangs up; a group call when the last person leaves
    if ((left?.joined ?? 0) === 0 || (scope === 'dm' && (left?.joined ?? 0) < 2)) await endCall(callId, 'ended');
    else {
        await maybeStopRinging(callId);
        await broadcast(callId);
    }
}

async function maybeStopRinging(callId: string) {
    const r = await Database.queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM call_participants WHERE call_id = $1 AND state = 'ringing'`, [callId]);
    if ((r?.n ?? 0) === 0) { clearTimeout(ringTimers.get(callId)); ringTimers.delete(callId); }
}

// ------------------------------------------------------------------ ending

/** Ring time is up: whoever did not answer has missed it. */
async function expireRinging(callId: string) {
    ringTimers.delete(callId);
    const c = await callView(callId);
    if (!c || c.ended_at) return;
    const ringing = c.participants.filter((p) => p.state === 'ringing');
    if (!ringing.length) return;
    await Database.query(`UPDATE call_participants SET state = 'missed' WHERE call_id = $1 AND state = 'ringing'`, [callId]);
    const team = await Database.queryOne<{ name: string }>('SELECT name FROM teams WHERE id = $1', [c.team_id]);
    const caller = c.participants.find((p) => p.user_id === c.initiator_id);
    for (const p of ringing) {
        SocketService.io?.to(userRoom(c.team_id, p.user_id)).emit('call:handled', { call_id: callId });
        void sendPush(p.user_id, { title: '', body: '', channel: 'call', ttlSeconds: 30, data: { type: 'call_cancel', call_id: callId } });
        void notifyUser(p.user_id, {
            teamId: c.team_id, type: 'call', label: c.scope === 'group' ? `Missed call · ${team?.name ?? ''}` : 'Missed call',
            title: caller?.name ?? 'Someone', body: `Missed ${c.kind} call`,
            data: { team_id: c.team_id, from_id: c.initiator_id, call_id: callId },
        }).catch(() => {});
    }
    if (c.scope === 'dm') await endCall(callId, 'missed');
    else await broadcast(callId);
}

export async function endCall(callId: string, reason: 'ended' | 'missed' | 'declined' | 'busy') {
    clearTimeout(ringTimers.get(callId));
    ringTimers.delete(callId);
    const done = await Database.queryOne<{ id: string; team_id: string; kind: CallKind; scope: CallScope; initiator_id: string; answered_at: string | null; started_at: string }>(
        `UPDATE calls SET ended_at = now(), end_reason = $2 WHERE id = $1 AND ended_at IS NULL
         RETURNING id, team_id, kind, scope, initiator_id, answered_at, started_at`,
        [callId, reason],
    );
    if (!done) return;
    const rest = await Database.queryAll<{ user_id: string; state: string }>(
        `UPDATE call_participants SET state = CASE WHEN state = 'ringing' THEN 'missed' WHEN state = 'joined' THEN 'left' ELSE state END,
                left_at = coalesce(left_at, now())
         WHERE call_id = $1 AND state IN ('ringing', 'joined') RETURNING user_id, state`,
        [callId],
    );
    for (const p of rest) {
        SocketService.io?.to(userRoom(done.team_id, p.user_id)).emit('call:handled', { call_id: callId });
        void sendPush(p.user_id, { title: '', body: '', channel: 'call', ttlSeconds: 30, data: { type: 'call_cancel', call_id: callId } });
    }
    const view = await callView(callId);
    const io = SocketService.io;
    if (view && io) {
        const rooms = view.participants.map((p) => userRoom(done.team_id, p.user_id));
        io.to(done.scope === 'group' ? [teamRoom(done.team_id), ...rooms] : rooms).emit('call:state', view);
    }

    // a line in the chat
    const seconds = done.answered_at ? Math.max(1, Math.round((Date.now() - new Date(done.answered_at).getTime()) / 1000)) : 0;
    try {
        if (done.scope === 'dm') {
            const other = view?.participants.find((p) => p.user_id !== done.initiator_id)?.user_id;
            if (other) {
                const body = done.answered_at ? `ended:${done.kind}:${seconds}` : reason === 'declined' ? `declined:${done.kind}` : `missed:${done.kind}`;
                await postCallMessage(done.team_id, done.initiator_id, other, body, !done.answered_at && reason === 'missed');
            }
        } else if (done.answered_at) {
            const joinedCount = (view?.participants ?? []).filter((p) => p.state === 'left' || p.state === 'joined').length;
            await postCallMessage(done.team_id, done.initiator_id, null, `group:${done.kind}:${seconds}:${joinedCount}`, false);
        }
    } catch (e) {
        Logger.error(`call message failed: ${(e as Error).message}`);
    }
}

// ------------------------------------------------------------------ housekeeping

/** Calls nobody ended (a crash, a lost connection) are closed after a while. */
async function expireStale() {
    const rows = await Database.queryAll<{ id: string }>(`SELECT id FROM calls WHERE ended_at IS NULL AND started_at < now() - interval '8 hours'`);
    for (const r of rows) await endCall(r.id, 'ended');
}

/**
 * Phones can die without saying goodbye. Every 30 seconds, ask LiveKit who is really in each running call;
 * people who are gone are marked as left, and an empty call is ended.
 */
let reconciler: ReturnType<typeof setInterval> | null = null;
function ensureReconciler() {
    if (reconciler || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET || !env.LIVEKIT_URL) return;
    const api = new RoomServiceClient(env.LIVEKIT_URL.replace(/^ws/, 'http'), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
    reconciler = setInterval(() => { void reconcile(api).catch(() => {}); }, 30_000);
    reconciler.unref?.();
}

async function reconcile(api: RoomServiceClient) {
    // a ring that outlived its timer (the server restarted) is a missed call
    const stuck = await Database.queryAll<{ call_id: string }>(
        `SELECT DISTINCT p.call_id FROM call_participants p JOIN calls c ON c.id = p.call_id
         WHERE p.state = 'ringing' AND c.ended_at IS NULL AND p.invited_at < now() - interval '90 seconds'`);
    for (const r of stuck) await expireRinging(r.call_id);
    const calls = await Database.queryAll<{ id: string; room: string; scope: CallScope }>(
        `SELECT id, room, scope FROM calls WHERE ended_at IS NULL AND started_at < now() - interval '40 seconds'`);
    for (const c of calls) {
        let present: Set<string>;
        try { present = new Set((await api.listParticipants(c.room)).map((p) => p.identity)); } catch { present = new Set(); }
        const joined = await Database.queryAll<{ user_id: string }>(
            `SELECT user_id FROM call_participants WHERE call_id = $1 AND state = 'joined' AND joined_at < now() - interval '30 seconds'`, [c.id]);
        const gone = joined.filter((p) => !present.has(p.user_id));
        if (!gone.length) continue;
        await Database.query(`UPDATE call_participants SET state = 'left', left_at = now() WHERE call_id = $1 AND user_id IN (SELECT jsonb_array_elements_text($2::jsonb)::uuid)`, [c.id, JSON.stringify(gone.map((g) => g.user_id))]);
        await afterLeave(c.id, c.scope);
    }
}
ensureReconciler();
