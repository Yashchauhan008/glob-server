import type { NextFunction, Request, Response } from 'express';
import { decodeJWTToken } from '@/shared/utilities/token.js';
import { TOKEN_TYPES } from '@/modules/auth/auth.constant.js';

export default async function authenticate(req: Request, res: Response, next: NextFunction) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const payload = token ? await decodeJWTToken<{ type: string; user_id: string }>(token) : null;

    if (!payload || payload.type !== TOKEN_TYPES.USER_ACCESS_TOKEN)
        return res.status(401).json({ code: 'unauthorized', message: 'Unauthorized' });

    req.user = { id: payload.user_id };
    next();
}
