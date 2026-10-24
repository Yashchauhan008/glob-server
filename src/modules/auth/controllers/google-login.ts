import type { NextFunction, Request, Response } from 'express';
import type { DatabaseClient } from '@/shared/helpers/database.helper.js';
import { STATUS_CODES } from '@/shared/constants/status-codes.js';
import { TOKEN_TYPES } from '../auth.constant.js';
import z from 'zod';
import { logAuth } from '@/modules/activity/activity.route.js';
import env from '@/shared/configs/env.js';
import { createJWTToken } from '@/shared/utilities/token.js';

export const ValidationSchema = {
    body: z.object({
        id_token: z.string().trim().min(10),
    }),
};

type GoogleProfile = { sub: string; email: string; name?: string; picture?: string; aud?: string; email_verified?: string };

async function verifyGoogleIdToken(idToken: string): Promise<GoogleProfile | null> {
    try {
        const url = new URL('https://oauth2.googleapis.com/tokeninfo');
        url.searchParams.set('id_token', idToken);
        const response = await fetch(url);
        if (!response.ok) return null;
        const data = (await response.json()) as GoogleProfile;
        if (data.aud !== env.GOOGLE_CLIENT_ID || data.email_verified !== 'true' || !data.email) return null;
        return data;
    } catch {
        return null;
    }
}

export async function Controller(
    req: Request,
    res: Response,
    next: NextFunction,
    db: DatabaseClient,
) {
    if (!env.GOOGLE_CLIENT_ID)
        return res.status(STATUS_CODES.NOT_FOUND).json({ message: 'Google sign-in is not enabled' });

    const { id_token: idToken } = req.body as z.infer<typeof ValidationSchema.body>;
    const profile = await verifyGoogleIdToken(idToken);
    if (!profile)
        return res.status(STATUS_CODES.UNAUTHORIZED).json({ message: 'Google sign-in failed' });

    const email = profile.email.toLowerCase();
    // an existing account with this email just signs in; otherwise one is created (no password)
    const existing = await db.queryOne('SELECT id, name, email FROM users WHERE email = $1', [email]);
    const user =
        existing ??
        (await db.queryOne(
            "INSERT INTO users (name, email, password_hash) VALUES ($1, $2, '') RETURNING id, name, email",
            [profile.name || email.split('@')[0], email],
        ));

    await logAuth(db, user.id, existing ? 'logged in with Google' : 'joined Glob with Google');

    const token = await createJWTToken({ type: TOKEN_TYPES.USER_ACCESS_TOKEN, user_id: user.id }, '24h');

    return res.status(STATUS_CODES.OK).json({
        token,
        user: { id: user.id, name: user.name, email: user.email },
    });
}
