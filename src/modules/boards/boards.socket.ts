import type { Server, Socket } from 'socket.io';
import Database from '@/shared/helpers/database.helper.js';
import { applyElements, release } from './board.store.js';

const room = (id: string) => `board:${id}`;
const isId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

async function sendPeers(io: Server, id: string) {
    const sockets = await io.in(room(id)).fetchSockets();
    const peers = [...new Map(sockets.map((s) => [s.data.user.id as string, { user_id: s.data.user.id as string, name: s.data.user.name as string }])).values()];
    io.to(room(id)).emit('board:peers', { boardId: id, peers });
    return sockets.length;
}

export default function registerBoards(io: Server, socket: Socket) {
    const user = socket.data.user as { id: string; name: string };

    const leave = async (id: string) => {
        socket.leave(room(id));
        socket.to(room(id)).emit('board:pointer-gone', { boardId: id, socket_id: socket.id });
        if ((await sendPeers(io, id)) === 0) await release(id).catch(() => {});
    };

    socket.on('board:join', async (payload: { boardId?: string }) => {
        if (!isId(payload?.boardId)) return;
        const exists = await Database.queryOne('SELECT 1 AS ok FROM boards WHERE id = $1', [payload.boardId]);
        if (!exists) return;
        socket.join(room(payload.boardId));
        await sendPeers(io, payload.boardId);
    });

    socket.on('board:leave', (payload: { boardId?: string }) => { if (isId(payload?.boardId)) void leave(payload.boardId); });

    socket.on('board:elements', async (payload: { boardId?: string; elements?: unknown[] }) => {
        if (!isId(payload?.boardId) || !socket.rooms.has(room(payload.boardId)) || !Array.isArray(payload.elements)) return;
        const accepted = await applyElements(payload.boardId, payload.elements.slice(0, 3000));
        if (accepted.length) socket.to(room(payload.boardId)).emit('board:elements', { boardId: payload.boardId, elements: accepted });
    });

    socket.on('board:pointer', (payload: { boardId?: string; x?: number; y?: number; tool?: string }) => {
        if (!isId(payload?.boardId) || !socket.rooms.has(room(payload.boardId))) return;
        if (typeof payload.x !== 'number' || typeof payload.y !== 'number') return;
        socket.to(room(payload.boardId)).volatile.emit('board:pointer', {
            boardId: payload.boardId, socket_id: socket.id, user_id: user.id, name: user.name,
            x: payload.x, y: payload.y, tool: payload.tool === 'laser' ? 'laser' : 'pointer',
        });
    });

    socket.on('disconnecting', () => {
        const ids = [...socket.rooms].filter((r) => r.startsWith('board:')).map((r) => r.slice(6));
        // after the socket is gone, tell the others and save if nobody is left
        setTimeout(() => ids.forEach((id) => { socket.to(room(id)).emit('board:pointer-gone', { boardId: id, socket_id: socket.id }); void sendPeers(io, id).then((n) => n === 0 && release(id)).catch(() => {}); }), 0);
    });
}
