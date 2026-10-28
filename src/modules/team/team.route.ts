import { Router } from 'express';
import z from 'zod';
import withDatabase from '@/shared/utilities/with-database.js';
import { validate } from '@/shared/helpers/validation.helper.js';
import { upload as imageUpload } from '@/shared/middlewares/multer/image-upload.js';
import { hardDeleteFile, registerNewFile } from '@/modules/file/file.service.js';

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
    remove_avatar: z.boolean().optional(),
});

const publicUser = 'id, name, email, avatar_url';

/** The stored copy of someone's old picture, so replacing or removing it does not leave files behind in S3. */
async function dropOldAvatar(db: Parameters<Parameters<typeof withDatabase>[0]>[3], url: string | null) {
    if (!url) return;
    const file = await db.queryOne('SELECT id FROM files WHERE url = $1', [url]);
    if (file) await hardDeleteFile(db, { id: file.id as string });
}

/** You can only change your own profile. */
router.patch('/me', withDatabase(async (req, res, _n, db) => {
    const b = validate(profile, req.body);
    const me = req.user!.id;
    const before = await db.queryOne('SELECT avatar_url FROM users WHERE id = $1', [me]);
    const row = await db.queryOne(
        `UPDATE users SET name = COALESCE($2, name),
            avatar_url = CASE WHEN $3::boolean THEN NULL ELSE avatar_url END, updated_at = now()
         WHERE id = $1 RETURNING ${publicUser}`,
        [me, b.name ?? null, b.remove_avatar === true],
    );
    if (b.remove_avatar) await dropOldAvatar(db, before?.avatar_url as string | null);
    res.json(row);
}));

/** Upload a new picture: cropped to a small square and compressed to half the size, then stored in S3. */
router.post('/me/avatar', imageUpload.single('file'), withDatabase(async (req, res, _n, db) => {
    if (!req.file) return res.status(400).json({ message: 'Choose a picture' });
    const me = req.user!.id;
    const before = await db.queryOne('SELECT avatar_url FROM users WHERE id = $1', [me]);
    const file = await registerNewFile(db, { filePath: req.file.path, _status: 'saved', compress: 'avatar' });
    const row = await db.queryOne(`UPDATE users SET avatar_url = $2, updated_at = now() WHERE id = $1 RETURNING ${publicUser}`, [me, file.url]);
    await dropOldAvatar(db, before?.avatar_url as string | null);
    res.json(row);
}));

export default router;
