import { unlink } from 'fs/promises';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import z from 'zod';
import withDatabase from '@/shared/utilities/with-database.js';
import { validate } from '@/shared/helpers/validation.helper.js';
import { upload as imageUpload } from '@/shared/middlewares/multer/image-upload.js';
import { hardDeleteFile, registerNewFile } from '@/modules/file/file.service.js';
import Database from '@/shared/helpers/database.helper.js';
import { ROOT_EMAIL, isRoot, isRootEmail } from '@/modules/access/access.service.js';
import { kickFromTeam, kickUser } from '@/modules/access/access.kick.js';
import { teamOwner } from '@/modules/teams/team.scope.js';
import { forgetMembership } from '@/modules/teams/team.service.js';
import { inviteEmails, notifyInvited } from '@/modules/teams/team.invites.js';

// Everything here works on the team the request is for (req.team), chosen by the X-Team-Id header.
const router = Router();

/** Platform-wide actions (blocking an account, deleting it) stay with the admin; they reach across every team. */
const rootOnly: RequestHandler = async (req, res, next) => {
    if (await isRoot(req.user!.id)) return next();
    res.status(403).json({ message: 'Only the admin can do this' });
};

/** Everyone in this team, with a few numbers for their card. Blocked people are only shown to owners. */
router.get('/', withDatabase(async (req, res, _n, db) => {
    const teamId = req.team!.id;
    const rows = await db.queryAll(
        `SELECT u.id, u.name, u.email, u.avatar_url, u.created_at, u.blocked_at, m.role,
                (SELECT count(*)::int FROM ideas i WHERE i.owner_id = u.id AND i.team_id = $1) AS ideas,
                (SELECT count(*)::int FROM todos t WHERE t.completed_by = u.id AND t.done AND t.team_id = $1) AS tasks_done,
                u.live_seconds::float8 AS live_seconds,
                (SELECT max(a.created_at) FROM activities a WHERE a.actor_id = u.id AND a.team_id = $1) AS last_active
         FROM team_members m JOIN users u ON u.id = m.user_id
         WHERE m.team_id = $1 ORDER BY lower(u.name)`,
        [teamId],
    );
    const manager = req.team!.role === 'owner';
    const items = rows
        .map(({ blocked_at, ...u }) => {
            const root = isRootEmail(u.email as string);
            return { ...u, status: root ? 'active' : blocked_at ? 'blocked' : 'active', is_root: root };
        })
        .filter((u) => manager || u.status === 'active');
    res.json({ items });
}));

/** Lets the app know which tools to show: the platform admin's, the team owner's, or none. */
router.get('/access', withDatabase(async (req, res) => {
    res.json({ is_root: await isRoot(req.user!.id), role: req.team!.role, can_manage: req.team!.role === 'owner' });
}));

// ---- invitations (team owners): who may join this team ----

router.get('/invites', teamOwner, withDatabase(async (req, res, _n, db) => {
    const items = await db.queryAll(
        `SELECT i.email, i.role, i.created_at, ab.name AS added_by
         FROM team_invites i LEFT JOIN users ab ON ab.id = i.added_by
         WHERE i.team_id = $1 ORDER BY i.created_at DESC, i.email`,
        [req.team!.id],
    );
    res.json({ items });
}));

const inviteBody = z.object({ emails: z.string().max(10000), role: z.enum(['owner', 'member']).default('member') });

router.post('/invites', teamOwner, withDatabase(async (req, res, _n, db) => {
    const { emails, role } = validate(inviteBody, req.body);
    const teamId = req.team!.id;
    const wanted = [...new Set(emails.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))].slice(0, 200);
    const valid = wanted.filter((e) => z.email().safeParse(e).success);
    const invalid = wanted.filter((e) => !valid.includes(e));
    if (!valid.length) return res.status(400).json({ message: invalid.length ? `Not a valid email: ${invalid.join(', ')}` : 'Type at least one email' });

    const fresh = await inviteEmails(db, teamId, req.user!.id, valid as string[], role);
    const added = fresh.length;
    res.status(201).json({ added, already: valid.length - added, invalid });
    void notifyInvited(teamId, req.user!.id, fresh); // after replying, so a slow mail server never holds up the page
}));

/** Withdraw a waiting invitation. If that email is not signed up anywhere and has no other invitation, it can no longer sign up. */
router.delete('/invites/:email', teamOwner, withDatabase(async (req, res, _n, db) => {
    const email = decodeURIComponent(String(req.params.email)).trim().toLowerCase();
    await db.query('DELETE FROM team_invites WHERE team_id = $1 AND email = $2', [req.team!.id, email]);
    if (!isRootEmail(email))
        await db.query(
            `DELETE FROM allowed_emails WHERE email = $1
               AND NOT EXISTS (SELECT 1 FROM team_invites WHERE email = $1)
               AND NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = $1)`,
            [email],
        );
    res.status(204).end();
}));

// ---- members ----

/** Loads the person to act on, and refuses to touch the admin or yourself. */
async function target(req: Request, res: Response) {
    const id = validate(z.string().uuid(), req.params.id);
    const row = await Database.queryOne('SELECT id, name, email, avatar_url FROM users WHERE id = $1', [id]);
    if (!row) { res.status(404).json({ message: 'Member not found' }); return null; }
    if (isRootEmail(row.email as string) || row.id === req.user!.id) {
        res.status(400).json({ message: 'You cannot do this to the admin account or to yourself' });
        return null;
    }
    return row;
}

/** Like target(), and the person must be in this team (so an owner can never reach into another team). */
async function teammate(req: Request, res: Response) {
    const who = await target(req, res);
    if (!who) return null;
    if (!(await Database.queryOne('SELECT 1 AS ok FROM team_members WHERE team_id = $1 AND user_id = $2', [req.team!.id, who.id as string]))) {
        res.status(404).json({ message: 'Member not found' });
        return null;
    }
    return who;
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

/** Make someone an owner of this team, or a regular member again. */
router.patch('/:id/role', teamOwner, async (req, res, next) => {
    try {
        const { role } = validate(z.object({ role: z.enum(['owner', 'member']) }), req.body);
        const who = await teammate(req, res);
        if (!who) return;
        await Database.query('UPDATE team_members SET role = $3 WHERE team_id = $1 AND user_id = $2', [req.team!.id, who.id as string, role]);
        forgetMembership(who.id as string);
        res.json({ id: who.id, role });
    } catch (e) { next(e); }
});

/** Take someone out of this team. Their ideas, tasks and messages stay with the team; their account and other teams are untouched. */
router.delete('/:id', teamOwner, async (req, res, next) => {
    try {
        const who = await teammate(req, res);
        if (!who) return;
        await Database.query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [req.team!.id, who.id as string]);
        await kickFromTeam(who.id as string, req.team!.id);
        res.status(204).end();
    } catch (e) { next(e); }
});

/** The stored copy of someone's old picture, so replacing or removing it does not leave files behind in S3. */
async function dropOldAvatar(db: Parameters<Parameters<typeof withDatabase>[0]>[3], url: string | null) {
    if (!url) return;
    const file = await db.queryOne('SELECT id FROM files WHERE url = $1', [url]);
    if (file) await hardDeleteFile(db, { id: file.id as string });
}

/**
 * Admin only: delete the account itself, from every team. Their ideas, tasks, leads, boards and messages stay useful,
 * so they are handed to the admin; their votes and activity log go with them.
 */
router.delete('/:id/account', rootOnly, withDatabase(async (req, res, _n, db) => {
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

/** Who is being edited: yourself ("me"), or - for the admin only - anyone. */
async function editableId(req: Request, res: Response): Promise<string | null> {
    const me = req.user!.id;
    const raw = req.params.id;
    const id = raw === undefined || raw === 'me' ? me : validate(z.string().uuid(), raw);
    if (id !== me && !(await isRoot(me))) { res.status(403).json({ message: 'Only the admin can edit other people' }); return null; }
    if (!(await Database.queryOne('SELECT 1 AS ok FROM users WHERE id = $1', [id]))) { res.status(404).json({ message: 'Member not found' }); return null; }
    return id;
}

/** Change a name, or remove a picture. Yourself, or anyone if you are the admin. */
router.patch(['/me', '/:id'], withDatabase(async (req, res, _n, db) => {
    const b = validate(profile, req.body);
    const id = await editableId(req, res);
    if (!id) return;
    const before = await db.queryOne('SELECT avatar_url FROM users WHERE id = $1', [id]);
    const row = await db.queryOne(
        `UPDATE users SET name = COALESCE($2, name),
            avatar_url = CASE WHEN $3::boolean THEN NULL ELSE avatar_url END, updated_at = now()
         WHERE id = $1 RETURNING ${publicUser}`,
        [id, b.name ?? null, b.remove_avatar === true],
    );
    if (b.remove_avatar) await dropOldAvatar(db, before?.avatar_url as string | null);
    res.json(row);
}));

/** Upload a new picture: cropped to a small square and compressed to half the size, then stored in S3. */
router.post(['/me/avatar', '/:id/avatar'], imageUpload.single('file'), withDatabase(async (req, res, _n, db) => {
    if (!req.file) return res.status(400).json({ message: 'Choose a picture' });
    const id = await editableId(req, res);
    if (!id) { void unlink(req.file.path).catch(() => {}); return; }
    const before = await db.queryOne('SELECT avatar_url FROM users WHERE id = $1', [id]);
    const file = await registerNewFile(db, { filePath: req.file.path, _status: 'saved', compress: 'avatar' });
    const row = await db.queryOne(`UPDATE users SET avatar_url = $2, updated_at = now() WHERE id = $1 RETURNING ${publicUser}`, [id, file.url]);
    await dropOldAvatar(db, before?.avatar_url as string | null);
    res.json(row);
}));

export default router;
