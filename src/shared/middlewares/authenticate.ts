import type { NextFunction, Request, Response } from 'express';
import { decodeJWTToken } from '@/shared/utilities/token.js';
import { TOKEN_TYPES } from '@/modules/auth/auth.constant.js';
import { accessFor } from '@/modules/access/access.service.js';

export default async function authenticate(req: Request, res: Response, next: NextFunction) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const payload = token ? await decodeJWTToken<{ type: string; user_id: string }>(token) : null;

    if (!payload || payload.type !== TOKEN_TYPES.USER_ACCESS_TOKEN)
        return res.status(401).json({ code: 'unauthorized', message: 'Unauthorized' });

    // 401 (not 403) so the app signs them out straight away instead of showing broken pages
    const access = await accessFor(payload.user_id);
    if ('reason' in access) return res.status(401).json({ code: 'access_removed', message: access.reason });

    req.user = { id: payload.user_id };
    next();
}
