import { SignJWT, importPKCS8 } from 'jose';
import env from '@/shared/configs/env.js';
import Logger from '@/shared/configs/logger.js';
import Database from '@/shared/helpers/database.helper.js';

type ServiceAccount = { project_id: string; client_email: string; private_key: string };

function loadAccount(): ServiceAccount | null {
    const raw = env.FCM_SERVICE_ACCOUNT?.trim();
    if (!raw) return null;
    try {
        const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
        const j = JSON.parse(text) as ServiceAccount;
        return j.project_id && j.client_email && j.private_key ? j : null;
    } catch {
        Logger.error('FCM_SERVICE_ACCOUNT is not valid JSON; push notifications are off');
        return null;
    }
}

const account = loadAccount();
export const pushEnabled = account !== null;

let cached: { token: string; until: number } | null = null;

async function accessToken(): Promise<string> {
    if (!account) throw new Error('push is not configured');
    if (cached && cached.until > Date.now() + 60_000) return cached.token;
    const key = await importPKCS8(account.private_key, 'RS256');
    const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/firebase.messaging' })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
        .setIssuer(account.client_email)
        .setSubject(account.client_email)
        .setAudience('https://oauth2.googleapis.com/token')
        .setIssuedAt()
        .setExpirationTime('55m')
        .sign(key);
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!res.ok) throw new Error(`FCM auth failed: ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: j.access_token, until: Date.now() + j.expires_in * 1000 };
    return cached.token;
}

export type PushPayload = {
    title: string;
    body: string;
    channel: 'dm' | 'workspace' | 'general' | 'call';
    data: Record<string, string>;
    /** how long Google may hold the push; a ringing call is worthless after ~30 seconds */
    ttlSeconds?: number;
};

/** Send one push to every phone this person has signed in on. Dead tokens are forgotten. */
export async function sendPush(userId: string, p: PushPayload) {
    if (!account) return;
    try {
        const tokens = await Database.queryAll<{ token: string }>('SELECT token FROM device_tokens WHERE user_id = $1', [userId]);
        if (!tokens.length) return;
        const bearer = await accessToken();
        await Promise.all(tokens.map(async ({ token }) => {
            const res = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: {
                        token,
                        // data only: the app draws the notification itself, so it can group and label it
                        data: { ...p.data, title: p.title, body: p.body, channel: p.channel },
                        android: { priority: 'HIGH', ...(p.ttlSeconds ? { ttl: `${p.ttlSeconds}s` } : {}) },
                    },
                }),
            });
            if (res.status === 404 || res.status === 400 || res.status === 403) {
                const text = await res.text();
                if (/UNREGISTERED|INVALID_ARGUMENT|NOT_FOUND/.test(text))
                    await Database.query('DELETE FROM device_tokens WHERE token = $1', [token]);
            }
        }));
    } catch (e) {
        Logger.error(`push failed: ${(e as Error).message}`);
    }
}
