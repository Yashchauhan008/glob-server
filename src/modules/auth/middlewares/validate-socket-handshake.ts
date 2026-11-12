import ServerError from '@/shared/utilities/server-error.class.js';
import { decodeJWTToken } from '@/shared/utilities/token.js';
import Database from '@/shared/helpers/database.helper.js';
import { Socket } from 'socket.io';
import { TOKEN_TYPES } from '../auth.constant.js';
import { accessFor } from '@/modules/access/access.service.js';
import { roleIn, teamRoom } from '@/modules/teams/team.service.js';

export default async function validateUserSocketHandShake(
    socket: Socket,
    next: (err?: Error) => void,
) {
    try {
        const token = socket.handshake.auth.token || socket.handshake.headers.authorization;

        if (!token) throw new ServerError('UNAUTHORIZED', 'token is required');
        if (!token.startsWith('Bearer ')) throw new ServerError('UNAUTHORIZED', 'invalid token');

        const tokenString = token.split(' ')[1];
        if (!tokenString) throw new ServerError('UNAUTHORIZED', 'token is required');

        const payload = await decodeJWTToken(tokenString);
        if (!payload || payload.type !== TOKEN_TYPES.USER_ACCESS_TOKEN)
            throw new ServerError('UNAUTHORIZED', 'invalid token');

        const user = await Database.queryOne('SELECT id, name FROM users WHERE id = $1', [
            payload.user_id as string,
        ]);
        if (!user) throw new ServerError('UNAUTHORIZED', 'invalid token');

        if (!(await accessFor(user.id)).ok) throw new ServerError('UNAUTHORIZED', 'access removed');

        // every connection belongs to one team: its chat, cursors and boards stay inside it
        const teamId = socket.handshake.auth.teamId;
        if (typeof teamId !== 'string' || !(await roleIn(user.id, teamId))) throw new ServerError('UNAUTHORIZED', 'choose a team');

        socket.data.user = { id: user.id, name: user.name };
        socket.data.team = { id: teamId };
        socket.join(user.id);
        socket.join(teamRoom(teamId));

        next();
    } catch (error) {
        next(error);
    }
}
