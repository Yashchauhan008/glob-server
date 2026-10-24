import type { Server, Socket } from 'socket.io';
import Database from '@/shared/helpers/database.helper.js';

export default function registerChat(io: Server, socket: Socket) {
    const user = socket.data.user as { id: string; name: string };

    socket.on('chat:send', async (payload: { body?: string }) => {
        const body = typeof payload?.body === 'string' ? payload.body.trim().slice(0, 2000) : '';
        if (!body) return;
        const row = await Database.queryOne(
            'INSERT INTO chat_messages (user_id, body) VALUES ($1,$2) RETURNING id, created_at',
            [user.id, body],
        );
        io.emit('chat:message', { id: row.id, user_id: user.id, name: user.name, body, created_at: row.created_at });
    });

    socket.on('chat:typing', () => socket.broadcast.emit('chat:typing', { user_id: user.id, name: user.name }));
}
