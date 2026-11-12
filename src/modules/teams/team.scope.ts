import type { NextFunction, Request, RequestHandler, RequestParamHandler, Response } from 'express';
import Database from '@/shared/helpers/database.helper.js';
import { roleIn } from './team.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every team route runs behind this: which team is the request for, and is this person in it? */
export async function teamScope(req: Request, res: Response, next: NextFunction) {
    try {
        const raw = req.headers['x-team-id'];
        const id = typeof raw === 'string' ? raw : '';
        if (!UUID.test(id)) return res.status(400).json({ code: 'team_required', message: 'Choose a team first' });
        const role = await roleIn(req.user!.id, id);
        if (!role) return res.status(403).json({ code: 'team_forbidden', message: 'You are not part of that team' });
        req.team = { id, role };
        next();
    } catch (e) { next(e); }
}

/** Only owners of the team (and the platform admin) may pass. */
export const teamOwner: RequestHandler = (req, res, next) => {
    if (req.team?.role === 'owner') return next();
    res.status(403).json({ message: 'Only a team owner can do this' });
};

/**
 * `router.param('id', inTeam('ideas'))`: a row from another team looks exactly like a row that does not exist.
 * Table names are constants written in code, never taken from the request.
 */
export const inTeam = (table: string): RequestParamHandler => async (req, res, next, id) => {
    try {
        const ok = UUID.test(id) && (await Database.queryOne(`SELECT 1 AS ok FROM ${table} WHERE id = $1 AND team_id = $2`, [id, req.team!.id]));
        if (ok) return next();
        res.status(404).json({ code: 'not_found', message: 'Not found' });
    } catch (e) { next(e); }
};

const OWNED = {
    ideas: 'SELECT 1 AS ok FROM ideas WHERE id = $1 AND team_id = $2',
    products: 'SELECT 1 AS ok FROM products WHERE id = $1 AND team_id = $2',
    leads: 'SELECT 1 AS ok FROM leads WHERE id = $1 AND team_id = $2',
    todos: 'SELECT 1 AS ok FROM todos WHERE id = $1 AND team_id = $2',
    events: 'SELECT 1 AS ok FROM events WHERE id = $1 AND team_id = $2',
    questions: 'SELECT 1 AS ok FROM questions WHERE id = $1 AND team_id = $2',
    boards: 'SELECT 1 AS ok FROM boards WHERE id = $1 AND team_id = $2',
    // a note belongs to an idea, and the idea belongs to the team
    idea_messages: 'SELECT 1 AS ok FROM idea_messages m JOIN ideas i ON i.id = m.idea_id WHERE m.id = $1 AND i.team_id = $2',
} as const;

/**
 * Links in a request body (idea_id, lead_id, ...) must point at things in the same team.
 * Pass { ideas: body.idea_id, leads: body.lead_id }; empty values are skipped. Returns false if any link is foreign.
 */
export async function linksInTeam(teamId: string, links: Partial<Record<keyof typeof OWNED, string | null | undefined>>) {
    for (const [table, id] of Object.entries(links) as [keyof typeof OWNED, string | null | undefined][]) {
        if (!id) continue;
        if (!(await Database.queryOne(OWNED[table], [id, teamId]))) return false;
    }
    return true;
}

export const foreignLink = (res: Response) => res.status(400).json({ message: 'That item belongs to a different team' });
