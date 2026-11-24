import Database from '@/shared/helpers/database.helper.js';
import SocketService from '@/socket.js';
import { sendPush, type PushPayload } from '@/modules/notifications/fcm.js';

export type NotifyInput = {
    teamId: string | null;
    type: 'dm' | 'chat' | 'answer' | 'call' | 'general';
    label: string; // the tag shown above the notification: "Direct message", "Workspace chat · Acme", ...
    title: string;
    body: string;
    data?: Record<string, string>;
    /** one unread notification per key is updated instead of piling up (a chat with 30 new messages is one entry) */
    groupKey?: string;
};

/**
 * Save a notification, show it live to anyone who has the app open, and push it to their phones.
 */
export async function notifyUser(userId: string, n: NotifyInput) {
    const data: Record<string, unknown> = { ...(n.data ?? {}), type: n.type };
    let row: any = null;

    if (n.groupKey) {
        row = await Database.queryOne(
            `UPDATE notifications
                SET body = $3, title = $4, created_at = now(),
                    data = jsonb_set(data || $5::jsonb, '{count}', to_jsonb(coalesce((data->>'count')::int, 1) + 1))
              WHERE id = (SELECT id FROM notifications
                           WHERE user_id = $1 AND read_at IS NULL AND data->>'group' = $2
                           ORDER BY created_at DESC LIMIT 1)
          RETURNING *`,
            [userId, n.groupKey, n.body, n.title, JSON.stringify(data)],
        );
    }
    if (!row) {
        row = await Database.queryOne(
            `INSERT INTO notifications (user_id, team_id, type, label, title, body, data)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
            [userId, n.teamId, n.type, n.label, n.title, n.body, JSON.stringify({ ...data, count: 1, ...(n.groupKey ? { group: n.groupKey } : {}) })],
        );
    }

    const io = SocketService.io;
    if (io) io.to(userId).emit('notification', row);

    const channel: PushPayload['channel'] = n.type === 'dm' || n.type === 'call' ? 'dm' : n.type === 'chat' ? 'workspace' : 'general';
    await sendPush(userId, {
        title: n.title,
        body: n.body,
        channel,
        data: {
            type: n.type,
            label: n.label,
            notification_id: String(row.id),
            ...(n.teamId ? { team_id: n.teamId } : {}),
            ...Object.fromEntries(Object.entries(n.data ?? {}).map(([k, v]) => [k, String(v)])),
        },
    });
    return row;
}
