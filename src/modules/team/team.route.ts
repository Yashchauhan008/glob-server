import { Router, type Request, type RequestHandler, type Response } from 'express';
import z from 'zod';
import withDatabase from '@/shared/utilities/with-database.js';
import { validate } from '@/shared/helpers/validation.helper.js';
import { upload as imageUpload } from '@/shared/middlewares/multer/image-upload.js';
import { hardDeleteFile, registerNewFile } from '@/modules/file/file.service.js';
import Database from '@/shared/helpers/database.helper.js';
import { ROOT_EMAIL, isRoot, isRootEmail } from '@/modules/access/access.service.js';
import { kickUser } from '@/modules/access/access.kick.js';

const router = Router();

const rootOnly: RequestHandler = async (req, res, next) => {
    if (await isRoot(req.user!.id)) return next();
    res.status(403).json({ message: 'Only the admin can do this' });
};

/** Everyone on the team, with a few numbers for their card. Blocked or un-invited people are only shown to the admin. */
router.get('/', withDatabase(async (req, res, _n, db) => {
    const rows = await db.queryAll(
        `SELECT u.id, u.name, u.email, u.avatar_url, u.created_at, u.blocked_at,
                EXISTS (SELECT 1 FROM allowed_emails a WHERE a.email = lower(u.email)) AS invited,
                (SELECT count(*)::int FROM ideas i WHERE i.owner_id = u.id) AS ideas,
                (SELECT count(*)::int FROM todos t WHERE t.owner_id = u.id AND t.done) AS tasks_done,
                (SELECT max(a.created_at) FROM activities a WHERE a.actor_id = u.id) AS last_active
         FROM users u ORDER BY lower(u.name)`,
    );
    const admin = await isRoot(req.user!.id);
    const items = rows
        .map(({ blocked_at, invited, ...u }) => {
            const root = isRootEmail(u.email as string);
            const status = root ? 'active' : blocked_at ? 'blocked' : invited ? 'active' : 'not_invited';
            return { ...u, status, is_root: root };
        })
        .filter((u) => admin || u.status === 'active');
    res.json({ items });
}));

/** Lets the app know whether to show the admin tools. */
router.get('/access', withDatabase(async (req, res) => { res.json({ is_root: await isRoot(req.user!.id) }); }));

// ---- invite list (admin only): who is allowed to sign in ----

router.get('/invites', rootOnly, withDatabase(async (_req, res, _n, db) => {
    const items = await db.queryAll(
        `SELECT a.email, a.created_at, u.id AS user_id, u.name, u.blocked_at, ab.name AS added_by
         FROM allowed_emails a
         LEFT JOIN users u ON lower(u.email) = a.email
         LEFT JOIN users ab ON ab.id = a.added_by
         ORDER BY a.created_at DESC, a.email`,
    );
    res.json({ root_email: ROOT_EMAIL || null, items: items.map(({ blocked_at, ...i }) => ({ ...i, blocked: !!blocked_at })) });
}));

const inviteBody = z.object({ emails: z.string().max(10000) });

router.post('/invites', rootOnly, withDatabase(async (req, res, _n, db) => {
    const { emails } = validate(inviteBody, req.body);
    const wanted = [...new Set(emails.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))].slice(0, 200);
    const valid = wanted.filter((e) => z.email().safeParse(e).success);
    const invalid = wanted.filter((e) => !valid.includes(e));
    if (!valid.length) return res.status(400).json({ message: invalid.length ? `Not a valid email: ${invalid.join(', ')}` : 'Type at least one email' });
    let added = 0;
    for (const email of valid) {
        const r = await db.query('INSERT INTO allowed_emails (email, added_by) VALUES ($1, $2) ON CONFLICT DO NOTHING', [email as string, req.user!.id as string]);
        added += r.rowCount ?? 0;
    }
    res.status(201).json({ added, already: valid.length - added, invalid });
}));

router.delete('/invites/:email', rootOnly, withDatabase(async (req, res, _n, db) => {
    const email = decodeURIComponent(String(req.params.email)).trim().toLowerCase();
    if (isRootEmail(email)) return res.status(400).json({ message: 'The admin email cannot be removed' });
    await db.query('DELETE FROM allowed_emails WHERE email = $1', [email]);
    // someone who was already signed in loses access straight away
    const user = await db.queryOne('SELECT id FROM users WHERE lower(email) = $1', [email]);
    if (user) await kickUser(user.id as string);
    res.status(204).end();
}));

// ---- block / unblock / remove a member (admin only) ----

/** Loads the person to act on, and refuses to touch the admin or yourself. */
async function target(req: Request, res: Response) {
    const id = validate(z.string().uuid(), req.params.id);
    const row = await Database.queryOne('SELECT id, name, email, avatar_url FROM users WHERE id = $1', [id]);
    if (!row) { res.status(404).json({ message: 'Member not found' }); return null; }
    if (isRootEmail(row.email as string) || row.id === req.user!.id) {
        res.status(400).json({ message: 'You cannot do this to the admin account' });
        return null;
    }
    return row;
}

router.post('/:id/block', rootOnly, async (req, res, next) => {
    try {
        const who = await target(req, res);
        if (!who) return;
        await Database.query('UPDATE users SET blocked_at = now() WHERE id = $1', [who.id as string]);
        await kickUser(who.id as string);
        res.json({ id: who.id, status: 'blocked' });
    } catch (e) { next(e); }
});

router.post('/:id/unblock', rootOnly, async (req, res, next) => {
    try {
        const who = await target(req, res);
        if (!who) return;
        await Database.query('UPDATE users SET blocked_at = NULL WHERE id = $1', [who.id as string]);
        await kickUser(who.id as string); // clears the remembered "blocked" answer
        res.json({ id: who.id, status: 'active' });
    } catch (e) { next(e); }
});

/**
 * Remove someone from the team for good. Their ideas, tasks, leads, boards and messages stay useful,
 * so they are handed to the admin; their votes and activity log go with them. They are also taken off the invite list.
 */
router.delete('/:id', rootOnly, withDatabase(async (req, res, _n, db) => {
    const who = await target(req, res);
    if (!who) return;
    const admin = await db.queryOne('SELECT id FROM users WHERE lower(email) = $1', [ROOT_EMAIL]);
    if (!admin) return res.status(400).json({ message: 'The admin account must exist to receive their work' });

    await db.begin();
    try {
        // every column that points at users: hand over anything that would block the delete (and attachments, which would otherwise vanish)
        const links = await db.queryAll(
            `SELECT c.conrelid::regclass::text AS tbl, quote_ident(a.attname) AS col, c.confdeltype AS action
             FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
             WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass AND array_length(c.conkey, 1) = 1`,
        );
        for (const l of links) {
            if (l.action === 'a' || l.action === 'r' || l.tbl === 'attachments')
                await db.query(`UPDATE ${l.tbl} SET ${l.col} = $1 WHERE ${l.col} = $2`, [admin.id as string, who.id as string]);
        }
        await db.query('DELETE FROM allowed_emails WHERE email = $1', [(who.email as string).toLowerCase()]);
        await db.query('DELETE FROM users WHERE id = $1', [who.id as string]);
        await db.commit();
    } catch (e) {
        await db.rollback();
        throw e;
    }
    await kickUser(who.id as string);
    if (who.avatar_url) await dropOldAvatar(db, who.avatar_url as string);
    res.status(204).end();
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
