import { Router } from 'express';
import z from 'zod';
import withDatabase from '@/shared/utilities/with-database.js';
import { validate } from '@/shared/helpers/validation.helper.js';

const router = Router();

/** Everyone on the team, with a few numbers for their card. */
router.get('/', withDatabase(async (_req, res, _n, db) => {
    const items = await db.queryAll(
        `SELECT u.id, u.name, u.email, u.avatar_url, u.created_at,
                (SELECT count(*)::int FROM ideas i WHERE i.owner_id = u.id) AS ideas,
                (SELECT count(*)::int FROM todos t WHERE t.owner_id = u.id AND t.done) AS tasks_done,
                (SELECT max(a.created_at) FROM activities a WHERE a.actor_id = u.id) AS last_active
         FROM users u ORDER BY lower(u.name)`,
    );
    res.json({ items });
}));

const profile = z.object({
    name: z.string().trim().min(1, 'Name cannot be empty').max(80).optional(),
    // upload the picture first (POST /attachments/upload), then send its file id; null removes it
    avatar_file_id: z.string().uuid().nullable().optional(),
});

/** You can only change your own profile. */
router.patch('/me', withDatabase(async (req, res, _n, db) => {
    const b = validate(profile, req.body);
    const me = req.user!.id;

    let avatarUrl: string | null | undefined;
    if (b.avatar_file_id === null) avatarUrl = null;
    else if (b.avatar_file_id) {
        const file = await db.queryOne('SELECT url FROM files WHERE id = $1', [b.avatar_file_id]);
        if (!file) return res.status(400).json({ message: 'Upload the picture first' });
        avatarUrl = file.url as string;
    }

    const row = await db.queryOne(
        `UPDATE users SET
            name = COALESCE($2, name),
            avatar_url = CASE WHEN $3::boolean THEN $4 ELSE avatar_url END,
            updated_at = now()
         WHERE id = $1 RETURNING id, name, email, avatar_url`,
        [me, b.name ?? null, avatarUrl !== undefined, avatarUrl ?? null],
    );
    res.json(row);
}));

export default router;
