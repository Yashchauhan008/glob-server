import Database from '@/shared/helpers/database.helper.js';
import type { DatabaseClient } from '@/shared/helpers/database.helper.js';
import env from '@/shared/configs/env.js';
import Logger from '@/shared/configs/logger.js';
import { renderEmailTemplates, sendMail } from '@/shared/utilities/mail.js';
import SocketService from '@/socket.js';
import { forgetMembership, teamRoom, type TeamRole } from './team.service.js';

/**
 * Put these (already validated, lower-case) emails into a team. People who already have an account join straight away;
 * the others wait as invitations and join when they sign up. Returns the emails that were actually new.
 */
export async function inviteEmails(db: DatabaseClient, teamId: string, byUserId: string, emails: string[], role: TeamRole = 'member') {
    const fresh: string[] = [];
    for (const email of emails) {
        // being invited to any team lets the email sign up; which team they land in is decided here
        await db.query('INSERT INTO allowed_emails (email, added_by) VALUES ($1, $2) ON CONFLICT DO NOTHING', [email, byUserId]);
        const existing = await db.queryOne('SELECT id FROM users WHERE lower(email) = $1', [email]);
        const r = existing
            ? await db.query('INSERT INTO team_members (team_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [teamId, existing.id as string, role])
            : await db.query('INSERT INTO team_invites (team_id, email, role, added_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [teamId, email, role, byUserId]);
        if (existing) forgetMembership(existing.id as string);
        if (r.rowCount) fresh.push(email);
    }
    return fresh;
}

/** The invited person may be offline. Keep the popup until they next open Glob, or send it now if they are here. */
async function holdInviteNotices(emails: string[], invitedBy: string, teamName: string) {
    const io = SocketService.io;
    const title = invitedBy ? `${invitedBy} invited you to ${teamName}` : `You are invited to ${teamName}`;
    for (const email of emails) {
        const body = `Open Glob to join ${teamName}`;
        const tag = `glob-invite-${email}`;
        const user = await Database.queryOne('SELECT id FROM users WHERE lower(email) = $1', [email]);
        const userId = user?.id as string | undefined;
        const sockets = userId && io ? await io.in(userId).fetchSockets() : [];
        if (sockets.length && io && userId) {
            io.to(userId).emit('notice', { title, body, tag });
            continue;
        }
        await Database.query(
            'INSERT INTO notices (user_id, email, title, body, tag) VALUES ($1, $2, $3, $4, $5)',
            [userId ?? null, email, title, body, tag],
        );
    }
}

async function sendInvites(emails: string[], invitedBy: string, teamName: string) {
    for (const email of emails) {
        try {
            const html = await renderEmailTemplates('invite', { email, invitedBy, teamName, appUrl: env.APP_URL });
            await sendMail({ to: email, subject: invitedBy ? `${invitedBy} invited you to ${teamName} on Glob` : `You are invited to ${teamName} on Glob`, html });
        } catch (e) {
            Logger.error(`Invite email to ${email} failed: ${(e as Error).message}`);
        }
    }
}

/** Tell the team, leave a popup for each invited person, and email them. Never throws. */
export async function notifyInvited(teamId: string, byUserId: string, emails: string[]) {
    if (!emails.length) return;
    try {
        const inviter = await Database.queryOne('SELECT name FROM users WHERE id = $1', [byUserId]);
        const team = await Database.queryOne('SELECT name FROM teams WHERE id = $1', [teamId]);
        const invitedBy = (inviter?.name as string | undefined) ?? '';
        const teamName = (team?.name as string | undefined) ?? 'Glob';
        SocketService.io?.to(teamRoom(teamId)).emit('team:invited', { emails, invitedBy, invitedById: byUserId });
        await holdInviteNotices(emails, invitedBy, teamName);
        await sendInvites(emails, invitedBy, teamName);
    } catch (e) {
        Logger.error(`Could not announce invitations: ${(e as Error).message}`);
    }
}
