import z from 'zod';
import env from '@/shared/configs/env.js';
import Database from '@/shared/helpers/database.helper.js';
import SocketService from '@/socket.js';
import { roleIn, teamRoom, userRoom } from '@/modules/teams/team.service.js';
import { notifyUser } from '@/modules/notifications/notify.service.js';

const KINDS = ['text', 'image', 'video', 'audio', 'file'] as const;

const messageInput = z.object({
    body: z.string().max(4000).default(''),
    kind: z.enum(KINDS).default('text'),
    file_url: z.string().max(2000).nullish(),
    file_name: z.string().max(255).nullish(),
    mime: z.string().max(120).nullish(),
    duration_ms: z.number().int().min(0).max(3_600_000).nullish(),
    client_id: z.string().max(64).nullish(),
});
export type MessageInput = z.infer<typeof messageInput>;

/** Checks what a client sent. Only files that went through our own upload can be attached. */
export function parseInput(raw: unknown): MessageInput {
    const r = messageInput.safeParse(raw ?? {});
    if (!r.success) throw new Error('That message could not be sent');
    const m = r.data;
    if (m.kind === 'text') {
        m.body = m.body.trim();
        if (!m.body) throw new Error('Type a message first');
        m.file_url = m.file_name = m.mime = null;
        m.duration_ms = null;
    } else {
        if (!m.file_url || !m.file_url.startsWith(env.FILE_STORAGE_ENDPOINT)) throw new Error('Upload the file first');
        m.body = m.body.trim();
    }
    return m;
}

const clock = (ms?: number | null) => {
    if (!ms) return '';
    const s = Math.round(ms / 1000);
    return ` ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export function preview(m: Pick<MessageInput, 'kind' | 'body' | 'file_name' | 'duration_ms'>) {
    switch (m.kind) {
        case 'image': return '📷 Photo';
        case 'video': return '🎥 Video';
        case 'audio': return `🎤 Voice message${clock(m.duration_ms)}`;
        case 'file': return `📎 ${m.file_name || 'Document'}`;
        default: return m.body.slice(0, 140);
    }
}

const CHAT_COLS = `m.id, m.user_id, u.name, u.avatar_url, m.body, m.kind, m.file_url, m.file_name, m.mime, m.duration_ms, m.client_id, m.created_at`;
const DM_COLS = `m.id, m.team_id, m.sender_id, m.recipient_id, u.name AS sender_name, u.avatar_url AS sender_avatar,
    m.body, m.kind, m.file_url, m.file_name, m.mime, m.duration_ms, m.client_id, m.created_at, m.delivered_at, m.read_at,
    CASE WHEN m.read_at IS NOT NULL THEN 'read' WHEN m.delivered_at IS NOT NULL THEN 'delivered' ELSE 'sent' END AS status`;

const chatById = (id: string) =>
    Database.queryOne(`SELECT ${CHAT_COLS} FROM chat_messages m JOIN users u ON u.id = m.user_id WHERE m.id = $1`, [id]);
const dmById = (id: string) =>
    Database.queryOne(`SELECT ${DM_COLS} FROM dm_messages m JOIN users u ON u.id = m.sender_id WHERE m.id = $1`, [id]);

type Who = { id: string; name: string };

// ---------------------------------------------------------------- workspace chat

export async function sendWorkspaceMessage(who: Who, teamId: string, raw: unknown) {
    const m = parseInput(raw);
    const row = await Database.queryOne<{ id: string }>(
        `INSERT INTO chat_messages (user_id, team_id, body, kind, file_url, file_name, mime, duration_ms, client_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (user_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [who.id, teamId, m.body, m.kind, m.file_url ?? null, m.file_name ?? null, m.mime ?? null, m.duration_ms ?? null, m.client_id ?? null],
    );
    if (!row) {
        // the same message sent twice (a retry): answer with the one we already have
        const prev = await Database.queryOne<{ id: string }>('SELECT id FROM chat_messages WHERE user_id = $1 AND client_id = $2', [who.id, m.client_id ?? null]);
        return prev ? chatById(prev.id) : null;
    }
    const msg = await chatById(row.id);
    SocketService.io?.to(teamRoom(teamId)).emit('chat:message', msg);

    void (async () => {
        const team = await Database.queryOne<{ name: string }>('SELECT name FROM teams WHERE id = $1', [teamId]);
        const members = await Database.queryAll<{ user_id: string }>('SELECT user_id FROM team_members WHERE team_id = $1 AND user_id <> $2', [teamId, who.id]);
        await Promise.allSettled(members.map((x) => notifyUser(x.user_id, {
            teamId,
            type: 'chat',
            label: `Workspace chat · ${team?.name ?? ''}`,
            title: who.name,
            body: preview(m),
            data: { team_id: teamId },
            groupKey: `chat:${teamId}`,
        })));
    })();
    return msg;
}

export async function markWorkspaceRead(userId: string, teamId: string) {
    await Database.query(
        `INSERT INTO chat_reads (user_id, team_id, last_read_at) VALUES ($1,$2,now())
         ON CONFLICT (user_id, team_id) DO UPDATE SET last_read_at = now()`,
        [userId, teamId],
    );
    await Database.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND team_id = $2 AND type = 'chat' AND read_at IS NULL`, [userId, teamId]);
}

export async function workspaceHistory(teamId: string, before: string | null, limit: number) {
    const rows = await Database.queryAll(
        `SELECT * FROM (
           SELECT ${CHAT_COLS} FROM chat_messages m JOIN users u ON u.id = m.user_id
           WHERE m.team_id = $1 AND ($2::timestamptz IS NULL OR m.created_at < $2)
           ORDER BY m.created_at DESC LIMIT $3
         ) t ORDER BY created_at`,
        [teamId, before, limit + 1],
    );
    const more = rows.length > limit;
    return { items: more ? rows.slice(1) : rows, has_more: more };
}

// ---------------------------------------------------------------- personal chat

export async function sendDirectMessage(who: Who, teamId: string, toId: string, raw: unknown) {
    const m = parseInput(raw);
    if (toId === who.id) throw new Error('You cannot message yourself');
    if (!(await roleIn(toId, teamId))) throw new Error('That person is not in this workspace');

    const io = SocketService.io;
    // delivered = the other person's app is connected right now (the second tick)
    const online = io ? (await io.in(userRoom(teamId, toId)).fetchSockets()).length > 0 : false;

    const row = await Database.queryOne<{ id: string }>(
        `INSERT INTO dm_messages (team_id, sender_id, recipient_id, body, kind, file_url, file_name, mime, duration_ms, client_id, delivered_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $11::boolean THEN now() ELSE NULL END)
         ON CONFLICT (sender_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [teamId, who.id, toId, m.body, m.kind, m.file_url ?? null, m.file_name ?? null, m.mime ?? null, m.duration_ms ?? null, m.client_id ?? null, online],
    );
    if (!row) {
        const prev = await Database.queryOne<{ id: string }>('SELECT id FROM dm_messages WHERE sender_id = $1 AND client_id = $2', [who.id, m.client_id ?? null]);
        return prev ? dmById(prev.id) : null;
    }
    const msg = await dmById(row.id);
    io?.to(userRoom(teamId, toId)).to(userRoom(teamId, who.id)).emit('dm:message', msg);

    void (async () => {
        const team = await Database.queryOne<{ name: string }>('SELECT name FROM teams WHERE id = $1', [teamId]);
        await notifyUser(toId, {
            teamId,
            type: 'dm',
            label: `Direct message · ${team?.name ?? ''}`,
            title: who.name,
            body: preview(m),
            data: { team_id: teamId, from_id: who.id },
            groupKey: `dm:${teamId}:${who.id}`,
        });
    })().catch(() => {});
    return msg;
}

/** The person opened the conversation: everything they were sent is now read (the blue ticks). */
export async function markDmRead(userId: string, teamId: string, withId: string) {
    const rows = await Database.queryAll<{ id: string }>(
        `UPDATE dm_messages SET read_at = now(), delivered_at = coalesce(delivered_at, now())
         WHERE team_id = $1 AND sender_id = $2 AND recipient_id = $3 AND read_at IS NULL RETURNING id`,
        [teamId, withId, userId],
    );
    await Database.query(
        `UPDATE notifications SET read_at = now()
         WHERE user_id = $1 AND team_id = $2 AND type = 'dm' AND data->>'from_id' = $3 AND read_at IS NULL`,
        [userId, teamId, withId],
    );
    if (rows.length) SocketService.io?.to(userRoom(teamId, withId)).emit('dm:status', { ids: rows.map((r) => r.id), status: 'read', by: userId });
    return rows.length;
}

/** A person just came online: what was waiting for them is now delivered (the second grey tick). */
export async function markDeliveredOnConnect(userId: string, teamId: string) {
    const rows = await Database.queryAll<{ id: string; sender_id: string }>(
        `UPDATE dm_messages SET delivered_at = now()
         WHERE team_id = $1 AND recipient_id = $2 AND delivered_at IS NULL RETURNING id, sender_id`,
        [teamId, userId],
    );
    const bySender = new Map<string, string[]>();
    for (const r of rows) bySender.set(r.sender_id, [...(bySender.get(r.sender_id) ?? []), r.id]);
    for (const [sender, ids] of bySender) SocketService.io?.to(userRoom(teamId, sender)).emit('dm:status', { ids, status: 'delivered', by: userId });
}

export async function dmHistory(userId: string, teamId: string, withId: string, before: string | null, limit: number) {
    const rows = await Database.queryAll(
        `SELECT * FROM (
           SELECT ${DM_COLS} FROM dm_messages m JOIN users u ON u.id = m.sender_id
           WHERE m.team_id = $1
             AND ((m.sender_id = $2 AND m.recipient_id = $3) OR (m.sender_id = $3 AND m.recipient_id = $2))
             AND ($4::timestamptz IS NULL OR m.created_at < $4)
           ORDER BY m.created_at DESC LIMIT $5
         ) t ORDER BY created_at`,
        [teamId, userId, withId, before, limit + 1],
    );
    const more = rows.length > limit;
    return { items: more ? rows.slice(1) : rows, has_more: more };
}

// ---------------------------------------------------------------- the inbox

export async function inbox(userId: string, teamId: string) {
    const team = await Database.queryOne('SELECT id, name FROM teams WHERE id = $1', [teamId]);
    const me = await Database.queryOne('SELECT id, name, email, avatar_url FROM users WHERE id = $1', [userId]);
    const members = await Database.queryAll(
        `SELECT u.id, u.name, u.email, u.avatar_url
         FROM team_members m JOIN users u ON u.id = m.user_id
         WHERE m.team_id = $1 AND u.id <> $2 AND u.blocked_at IS NULL ORDER BY lower(u.name)`,
        [teamId, userId],
    );
    const last = await Database.queryAll(
        `SELECT DISTINCT ON (partner) partner, id, body, kind, file_name, duration_ms, created_at, sender_id,
                CASE WHEN read_at IS NOT NULL THEN 'read' WHEN delivered_at IS NOT NULL THEN 'delivered' ELSE 'sent' END AS status
         FROM (SELECT CASE WHEN sender_id = $2 THEN recipient_id ELSE sender_id END AS partner, *
               FROM dm_messages WHERE team_id = $1 AND (sender_id = $2 OR recipient_id = $2)) t
         ORDER BY partner, created_at DESC`,
        [teamId, userId],
    );
    const unread = await Database.queryAll<{ sender_id: string; n: number }>(
        `SELECT sender_id, count(*)::int AS n FROM dm_messages
         WHERE team_id = $1 AND recipient_id = $2 AND read_at IS NULL GROUP BY sender_id`,
        [teamId, userId],
    );
    const lastBy = new Map(last.map((l: any) => [l.partner as string, l]));
    const unreadBy = new Map(unread.map((u) => [u.sender_id, u.n]));
    const dms = members
        .map((u: any) => ({ user: u, last_message: lastBy.get(u.id) ?? null, unread: unreadBy.get(u.id) ?? 0 }))
        .filter((d) => d.last_message)
        .sort((a, b) => String(b.last_message.created_at).localeCompare(String(a.last_message.created_at)));

    const wsLast = await Database.queryOne(
        `SELECT m.id, m.user_id, u.name, m.body, m.kind, m.file_name, m.duration_ms, m.created_at
         FROM chat_messages m JOIN users u ON u.id = m.user_id WHERE m.team_id = $1 ORDER BY m.created_at DESC LIMIT 1`,
        [teamId],
    );
    const wsUnread = await Database.queryOne<{ n: number }>(
        `SELECT count(*)::int AS n FROM chat_messages c
         WHERE c.team_id = $1 AND c.user_id <> $2
           AND c.created_at > coalesce((SELECT last_read_at FROM chat_reads r WHERE r.user_id = $2 AND r.team_id = $1), 'epoch')`,
        [teamId, userId],
    );
    return {
        team,
        me,
        workspace: { last_message: wsLast, unread: wsUnread?.n ?? 0, members: members.length + 1 },
        dms,
        members,
    };
}
