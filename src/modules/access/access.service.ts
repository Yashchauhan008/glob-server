import env from '@/shared/configs/env.js';
import Database from '@/shared/helpers/database.helper.js';

export const ROOT_EMAIL = (env.ROOT_EMAIL ?? '').trim().toLowerCase();
export const isRootEmail = (email?: string | null) => !!ROOT_EMAIL && !!email && email.trim().toLowerCase() === ROOT_EMAIL;

export const DENIED = {
    blocked: 'Your account has been blocked. Ask the admin to restore your access.',
    notInvited: 'This email has not been invited to Glob. Ask the admin to add it.',
    gone: 'Your access to Glob has been removed.',
};

/** Is this email on the invite list? (The root email always is.) */
export async function emailAllowed(email: string): Promise<boolean> {
    if (isRootEmail(email)) return true;
    return !!(await Database.queryOne('SELECT 1 AS ok FROM allowed_emails WHERE email = $1', [email.trim().toLowerCase()]));
}

type Verdict = { ok: true } | { ok: false; reason: string };

// every request asks this, so the answer is remembered for a few seconds (and dropped the moment someone is blocked)
const TTL = 10_000;
const cache = new Map<string, { v: Verdict; at: number }>();
export const forgetAccess = (userId: string) => { cache.delete(userId); };

/** May this signed-in person still use Glob right now? */
export async function accessFor(userId: string): Promise<Verdict> {
    const hit = cache.get(userId);
    if (hit && Date.now() - hit.at < TTL) return hit.v;

    const row = await Database.queryOne(
        `SELECT u.email, u.blocked_at,
                EXISTS (SELECT 1 FROM allowed_emails a WHERE a.email = lower(u.email)) AS invited
         FROM users u WHERE u.id = $1`,
        [userId],
    );
    let v: Verdict;
    if (!row) v = { ok: false, reason: DENIED.gone };
    else if (isRootEmail(row.email as string)) v = { ok: true };
    else if (row.blocked_at) v = { ok: false, reason: DENIED.blocked };
    else if (!row.invited) v = { ok: false, reason: DENIED.notInvited };
    else v = { ok: true };

    cache.set(userId, { v, at: Date.now() });
    return v;
}

export async function isRoot(userId: string): Promise<boolean> {
    const row = await Database.queryOne('SELECT email FROM users WHERE id = $1', [userId]);
    return isRootEmail(row?.email as string | undefined);
}
