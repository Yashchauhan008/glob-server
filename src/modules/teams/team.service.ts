import Database from '@/shared/helpers/database.helper.js';
import type { DatabaseClient } from '@/shared/helpers/database.helper.js';
import { isRoot } from '@/modules/access/access.service.js';

export type TeamRole = 'owner' | 'member';

// every request asks this, so the answer is remembered for a few seconds (and dropped when membership changes)
const TTL = 10_000;
const cache = new Map<string, { role: TeamRole | null; at: number }>();
const key = (userId: string, teamId: string) => `${userId}:${teamId}`;
export const forgetMembership = (userId: string) => {
    for (const k of cache.keys()) if (k.startsWith(`${userId}:`)) cache.delete(k);
};

/** What is this person in this team? The platform admin is an owner of every team; null means "not in it". */
export async function roleIn(userId: string, teamId: string): Promise<TeamRole | null> {
    const hit = cache.get(key(userId, teamId));
    if (hit && Date.now() - hit.at < TTL) return hit.role;

    let role: TeamRole | null = null;
    if (await Database.queryOne('SELECT 1 AS ok FROM teams WHERE id = $1', [teamId])) {
        if (await isRoot(userId)) role = 'owner';
        else {
            const row = await Database.queryOne('SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, userId]);
            role = (row?.role as TeamRole | undefined) ?? null;
        }
    }
    cache.set(key(userId, teamId), { role, at: Date.now() });
    return role;
}

/** Turn invitations waiting for this email into memberships. Called whenever someone signs up or signs in. */
export async function claimInvites(db: DatabaseClient, userId: string, email: string) {
    const lower = email.trim().toLowerCase();
    await db.query(
        `INSERT INTO team_members (team_id, user_id, role)
         SELECT team_id, $1, role FROM team_invites WHERE email = $2
         ON CONFLICT DO NOTHING`,
        [userId, lower],
    );
    await db.query('DELETE FROM team_invites WHERE email = $1', [lower]);
    forgetMembership(userId);
}

/** The teams this person can open. The platform admin sees every team. */
export async function teamsFor(userId: string) {
    const admin = await isRoot(userId);
    return Database.queryAll(
        `SELECT t.id, t.name, t.created_at,
                ${admin ? '$1::text' : 'm.role'} AS role,
                (SELECT count(*)::int FROM team_members x WHERE x.team_id = t.id) AS members
         FROM teams t ${admin ? '' : 'JOIN team_members m ON m.team_id = t.id AND m.user_id = $1'}
         ORDER BY lower(t.name)`,
        admin ? ['owner'] : [userId],
    );
}

/** The call room and the live-connection room of a team, named in one place. */
export const callRoom = (teamId: string) => `glob-live-${teamId}`;
export const teamRoom = (teamId: string) => `team:${teamId}`;
