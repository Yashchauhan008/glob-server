import type { Server, Socket } from 'socket.io';

import { teamRoom } from '@/modules/teams/team.service.js';

const roomOf = (teamId: string, route: string) => `route:${teamId}:${route}`;

/** Who is where, told only to the people in the same team. */
async function broadcastRoster(io: Server, teamId: string) {
    const sockets = await io.in(teamRoom(teamId)).fetchSockets();
    const roster = sockets
        .filter((s) => s.data.user && s.data.route)
        .map((s) => ({ user_id: s.data.user.id as string, name: s.data.user.name as string, route: s.data.route as string }));
    io.to(teamRoom(teamId)).emit('presence:roster', roster);
}

export default function registerPresence(io: Server, socket: Socket) {
    const user = socket.data.user as { id: string; name: string };
    const teamId = socket.data.team.id as string;

    const leaveCurrent = () => {
        const route = socket.data.route as string | undefined;
        if (!route) return;
        socket.leave(roomOf(teamId, route));
        socket.to(roomOf(teamId, route)).emit('presence:leave', { user_id: user.id });
        socket.data.route = undefined;
    };

    socket.on('presence:route', async (payload: { route?: string }) => {
        const route = typeof payload?.route === 'string' ? payload.route.slice(0, 200) : '';
        if (!route.startsWith('/')) return;
        if (socket.data.route !== route) {
            leaveCurrent();
            socket.data.route = route;
            socket.join(roomOf(teamId, route));
        }
        await broadcastRoster(io, teamId);
    });

    // Ask after the listener exists, so a route sent before this handler was
    // attached is not the only attempt.
    socket.emit('presence:hello');

    socket.on('presence:cursor', (payload: { x?: number; y?: number }) => {
        const route = socket.data.route as string | undefined;
        const { x, y } = payload || {};
        if (!route || typeof x !== 'number' || typeof y !== 'number') return;
        socket.to(roomOf(teamId, route)).emit('presence:cursor', {
            user_id: user.id,
            name: user.name,
            x: Math.min(1, Math.max(0, x)),
            y: Math.min(1.5, Math.max(0, y)),
        });
    });

    socket.on('disconnect', async () => {
        leaveCurrent();
        // roster is rebuilt after this socket is gone
        setTimeout(() => broadcastRoster(io, teamId).catch(() => {}), 0);
    });
}
