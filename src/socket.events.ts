import Database from '@/shared/helpers/database.helper.js';
import Logger from '@/shared/configs/logger.js';
import type { Context as SocketContext } from '@/shared/utilities/socket-handler.js';

import registerSocketEventHandler from '@/shared/utilities/socket-handler.js';
import registerChat from '@/modules/chat/chat.socket.js';
import registerPresence from '@/modules/presence/presence.socket.js';
import registerBoards from '@/modules/boards/boards.socket.js';
import { Handler as onUserDisconnectHandler } from '@/modules/user/handlers/socket/on-user-disconnect.js';

export default async function Handler({ io, socket }: SocketContext) {
    const user = socket.data.user;
    if (!user) return;

    const userId: string = user.id;

    Logger.info(`User connected: ${userId} (socket: ${socket.id})`);

    // Register before any await. The client is already told the socket is up,
    // and its first presence:route arrives while fetchSockets is still running.
    registerPresence(io, socket);
    registerChat(io, socket);
    registerBoards(io, socket);

    socket.on('ping', (message: string) => {
        socket.emit('pong', message);
    });

    socket.on('notice:seen', async (payload: { id?: string }) => {
        if (!payload?.id) return;
        await Database.query(
            `DELETE FROM notices WHERE id = $1 AND (user_id = $2 OR email = (SELECT lower(email) FROM users WHERE id = $2))`,
            [payload.id, userId],
        );
    });

    socket.on(
        'disconnect',
        registerSocketEventHandler({
            io,
            socket,
            handler: onUserDisconnectHandler,
        }),
    );

    const pending = await Database.queryAll(
        `SELECT n.id, n.title, n.body, n.tag
         FROM notices n
         JOIN users u ON u.id = $1
         WHERE n.user_id = u.id OR n.email = lower(u.email)
         ORDER BY n.created_at`,
        [userId],
    );
    for (const n of pending) socket.emit('notice', { id: n.id, title: n.title, body: n.body, tag: n.tag });

    const sockets = await io.in(userId).fetchSockets();
    if (sockets.length === 1) {
        socket.rooms.forEach((room) => {
            if (room !== userId) {
                socket.to(room).emit('user:online', { user_id: userId });
            }
        });
    }

}
