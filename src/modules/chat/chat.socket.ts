import type { Server, Socket } from 'socket.io';
import { teamRoom, userRoom, roleIn } from '@/modules/teams/team.service.js';
import {
    markDeliveredOnConnect, markDmRead, markWorkspaceRead, reactToMessage, sendDirectMessage, sendWorkspaceMessage,
} from '@/modules/messaging/messaging.service.js';

type Ack = (r: { ok: boolean; message?: unknown; error?: string }) => void;
const reply = (ack: unknown, r: { ok: boolean; message?: unknown; error?: string }) => { if (typeof ack === 'function') (ack as Ack)(r); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function registerChat(io: Server, socket: Socket) {
    const user = socket.data.user as { id: string; name: string };
    const teamId = socket.data.team.id as string;

    // what was waiting for me while I was away is now delivered
    markDeliveredOnConnect(user.id, teamId).catch(() => {});

    // ---- workspace chat. The acknowledgement is the "sent" tick; failing to get it is the red "failed" mark.
    socket.on('chat:send', async (payload: unknown, ack?: Ack) => {
        try {
            reply(ack, { ok: true, message: await sendWorkspaceMessage(user, teamId, payload) });
        } catch (e) { reply(ack, { ok: false, error: (e as Error).message }); }
    });
    socket.on('chat:typing', () => socket.to(teamRoom(teamId)).emit('chat:typing', { user_id: user.id, name: user.name }));
    socket.on('chat:read', () => { markWorkspaceRead(user.id, teamId).catch(() => {}); });

    socket.on('message:react', async (payload: { id?: string; emoji?: string | null }, ack?: Ack) => {
        try {
            if (typeof payload?.id !== 'string' || !UUID.test(payload.id)) throw new Error('Message not found');
            reply(ack, { ok: true, message: await reactToMessage(user, teamId, payload.id, typeof payload.emoji === 'string' ? payload.emoji : null) });
        } catch (e) { reply(ack, { ok: false, error: (e as Error).message }); }
    });

    // ---- personal chat
    socket.on('dm:send', async (payload: { to?: string } & Record<string, unknown>, ack?: Ack) => {
        try {
            if (typeof payload?.to !== 'string' || !UUID.test(payload.to)) throw new Error('Choose who to write to');
            reply(ack, { ok: true, message: await sendDirectMessage(user, teamId, payload.to, payload) });
        } catch (e) { reply(ack, { ok: false, error: (e as Error).message }); }
    });
    socket.on('dm:typing', async (payload: { to?: string }) => {
        if (typeof payload?.to !== 'string' || !UUID.test(payload.to) || !(await roleIn(payload.to, teamId))) return;
        io.to(userRoom(teamId, payload.to)).emit('dm:typing', { from: user.id, name: user.name });
    });
    socket.on('dm:read', async (payload: { with?: string }) => {
        if (typeof payload?.with !== 'string' || !UUID.test(payload.with)) return;
        await markDmRead(user.id, teamId, payload.with).catch(() => {});
    });
}
