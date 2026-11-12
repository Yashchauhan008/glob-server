import { Router } from 'express';
import type { RequestHandler } from 'express';
import z from 'zod';
import withDatabase from '@/shared/utilities/with-database.js';
import { validate } from '@/shared/helpers/validation.helper.js';
import { hardDeleteFile } from '@/modules/file/file.service.js';
import { isRoot } from '@/modules/access/access.service.js';
import SocketService from '@/socket.js';
import { kickFromTeam } from '@/modules/access/access.kick.js';
import { forgetMembership, roleIn, teamRoom, teamsFor } from './team.service.js';
import { inviteEmails, notifyInvited } from './team.invites.js';

// Platform level: these routes do not need a team to be chosen, because they are how you choose one.
const router = Router();

const rootOnly: RequestHandler = async (req, res, next) => {
    if (await isRoot(req.user!.id)) return next();
    res.status(403).json({ message: 'Only the admin can do this' });
};

const name = z.string().trim().min(1, 'Give the team a name').max(80);

/** The teams you can open: the ones you belong to, or every team if you are the admin. */
router.get('/', withDatabase(async (req, res, _n, db) => {
    const me = await db.queryOne('SELECT last_team_id FROM users WHERE id = $1', [req.user!.id]);
    res.json({ is_root: await isRoot(req.user!.id), last_team_id: me?.last_team_id ?? null, items: await teamsFor(req.user!.id) });
}));

/** Remember which team this person is working in, so the next sign-in (on any device) opens it. */
router.put('/:id/last', withDatabase(async (req, res, _n, db) => {
    const id = validate(z.string().uuid(), req.params.id);
    if (!(await roleIn(req.user!.id, id))) return res.status(403).json({ message: 'You are not part of that team' });
    await db.query('UPDATE users SET last_team_id = $2 WHERE id = $1', [req.user!.id, id]);
    res.status(204).end();
}));

/** Admin: start a new team, and optionally name the first owner (who is invited by email if they have no account yet). */
router.post('/', rootOnly, withDatabase(async (req, res, _n, db) => {
    const b = validate(z.object({ name, owner_email: z.string().trim().toLowerCase().pipe(z.email()).optional().or(z.literal('')) }), req.body);
    const team = await db.queryOne('INSERT INTO teams (name, created_by) VALUES ($1, $2) RETURNING id, name, created_at', [b.name, req.user!.id]);
    let invited: string[] = [];
    if (b.owner_email) invited = await inviteEmails(db, team.id as string, req.user!.id, [b.owner_email], 'owner');
    const members = await db.queryOne('SELECT count(*)::int AS n FROM team_members WHERE team_id = $1', [team.id as string]);
    res.status(201).json({ ...team, role: 'owner', members: members?.n ?? 0 });
    void notifyInvited(team.id as string, req.user!.id, invited);
}));

// ---- admin: who is in a team ----

const teamId = (req: { params: Record<string, unknown> }): string => validate(z.string().uuid(), req.params.id) as string;

/** Members of a team, people still waiting to join, and everyone with an account who is not in it yet. */
router.get('/:id/members', rootOnly, withDatabase(async (req, res, _n, db) => {
    const id = teamId(req);
    if (!(await db.queryOne('SELECT 1 AS ok FROM teams WHERE id = $1', [id]))) return res.status(404).json({ message: 'Team not found' });
    const [members, pending, available] = await Promise.all([
        db.queryAll('SELECT u.id, u.name, u.email, m.role FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = $1 ORDER BY lower(u.name)', [id]),
        db.queryAll('SELECT email, role FROM team_invites WHERE team_id = $1 ORDER BY email', [id]),
        db.queryAll('SELECT u.id, u.name, u.email FROM users u WHERE NOT EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = $1 AND m.user_id = u.id) ORDER BY lower(u.name)', [id]),
    ]);
    res.json({ members, pending, available });
}));

/** Add people by email (existing accounts join now, new emails wait as invitations). */
router.post('/:id/members', rootOnly, withDatabase(async (req, res, _n, db) => {
    const id = teamId(req);
    const b = validate(z.object({ emails: z.string().max(10000), role: z.enum(['owner', 'member']).default('member') }), req.body);
    if (!(await db.queryOne('SELECT 1 AS ok FROM teams WHERE id = $1', [id]))) return res.status(404).json({ message: 'Team not found' });
    const wanted = [...new Set((b.emails as string).split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))].slice(0, 200) as string[];
    const valid = wanted.filter((e) => z.email().safeParse(e).success) as string[];
    const invalid = wanted.filter((e) => !valid.includes(e));
    if (!valid.length) return res.status(400).json({ message: invalid.length ? `Not a valid email: ${invalid.join(', ')}` : 'Type at least one email' });
    const fresh = await inviteEmails(db, id, req.user!.id, valid, b.role);
    res.status(201).json({ added: fresh.length, already: valid.length - fresh.length, invalid });
    void notifyInvited(id, req.user!.id, fresh);
}));

router.patch('/:id/members/:userId', rootOnly, withDatabase(async (req, res, _n, db) => {
    const id = teamId(req);
    const userId = validate(z.string().uuid(), req.params.userId);
    const { role } = validate(z.object({ role: z.enum(['owner', 'member']) }), req.body);
    const r = await db.query('UPDATE team_members SET role = $3 WHERE team_id = $1 AND user_id = $2', [id, userId, role]);
    if (!r.rowCount) return res.status(404).json({ message: 'Member not found' });
    forgetMembership(userId);
    res.json({ id: userId, role });
}));

router.delete('/:id/members/:userId', rootOnly, withDatabase(async (req, res, _n, db) => {
    const id = teamId(req);
    const userId = validate(z.string().uuid(), req.params.userId);
    await db.query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [id, userId]);
    await kickFromTeam(userId, id);
    res.status(204).end();
}));

router.delete('/:id/invites/:email', rootOnly, withDatabase(async (req, res, _n, db) => {
    const id = teamId(req);
    await db.query('DELETE FROM team_invites WHERE team_id = $1 AND email = $2', [id, decodeURIComponent(String(req.params.email)).toLowerCase()]);
    res.status(204).end();
}));

router.patch('/:id', rootOnly, withDatabase(async (req, res, _n, db) => {
    const id = validate(z.string().uuid(), req.params.id);
    const b = validate(z.object({ name }), req.body);
    const row = await db.queryOne('UPDATE teams SET name = $2 WHERE id = $1 RETURNING id, name', [id, b.name]);
    if (!row) return res.status(404).json({ message: 'Team not found' });
    SocketService.io?.to(teamRoom(id)).emit('team:renamed', row);
    res.json(row);
}));

/**
 * Admin: delete a team and everything in it. Pictures and files it uploaded are removed from storage too,
 * and anyone inside it right now is disconnected.
 */
router.delete('/:id', rootOnly, withDatabase(async (req, res, _n, db) => {
    const id = validate(z.string().uuid(), req.params.id);
    if (!(await db.queryOne('SELECT 1 AS ok FROM teams WHERE id = $1', [id]))) return res.status(404).json({ message: 'Team not found' });

    const files = await db.queryAll(
        `SELECT file_id AS id FROM attachments WHERE team_id = $1 AND file_id IS NOT NULL
         UNION SELECT thumb_file_id FROM attachments WHERE team_id = $1 AND thumb_file_id IS NOT NULL
         UNION SELECT thumb_file_id FROM boards WHERE team_id = $1 AND thumb_file_id IS NOT NULL
         UNION SELECT (v->>'file_id')::uuid FROM boards b, jsonb_each(b.images) e(k, v) WHERE b.team_id = $1 AND v->>'file_id' IS NOT NULL`,
        [id],
    );
    const members = await db.queryAll('SELECT user_id FROM team_members WHERE team_id = $1', [id]);
    const sockets = (await SocketService.io?.in(teamRoom(id)).fetchSockets()) ?? [];

    await db.query('DELETE FROM teams WHERE id = $1', [id]); // everything the team owns goes with it
    for (const f of files) await hardDeleteFile(db, { id: f.id as string }).catch(() => {});
    for (const s of sockets) s.disconnect(true);
    for (const m of members) forgetMembership(m.user_id as string);
    res.status(204).end();
}));

export default router;
