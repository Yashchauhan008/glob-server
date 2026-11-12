import type { DatabaseClient } from '@/shared/helpers/database.helper.js';

/** Remember this sign-in, and keep the one before it so the account card can say "last time you were here". */
export const recordLogin = (db: DatabaseClient, userId: string) =>
    db.query(
        'UPDATE users SET prev_login_at = last_login_at, last_login_at = now(), login_count = login_count + 1 WHERE id = $1',
        [userId],
    ).catch(() => {});
