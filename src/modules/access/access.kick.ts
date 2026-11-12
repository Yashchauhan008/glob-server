import { RoomServiceClient } from 'livekit-server-sdk';
import env from '@/shared/configs/env.js';
import SocketService from '@/socket.js';
import { forgetAccess } from './access.service.js';
import { callRoom, forgetMembership } from '@/modules/teams/team.service.js';

const livekit = () =>
    env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET
        ? new RoomServiceClient(env.LIVEKIT_URL.replace(/^ws/, 'http'), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET)
        : null;

/** Throw someone out right now: their open pages lose the live connection and they drop out of every call. */
export async function kickUser(userId: string) {
    forgetAccess(userId);
    forgetMembership(userId);
    SocketService.io?.in(userId).disconnectSockets(true);
    const api = livekit();
    if (!api) return;
    try {
        for (const room of await api.listRooms()) {
            if (room.name.startsWith('glob-live-')) await api.removeParticipant(room.name, userId).catch(() => {});
        }
    } catch { /* not in a call */ }
}

/** Take someone out of one team only: that team's live connection and call end, their other teams carry on. */
export async function kickFromTeam(userId: string, teamId: string) {
    forgetMembership(userId);
    const sockets = (await SocketService.io?.in(userId).fetchSockets()) ?? [];
    for (const s of sockets) if (s.data.team?.id === teamId) s.disconnect(true);
    try { await livekit()?.removeParticipant(callRoom(teamId), userId); } catch { /* not in a call */ }
}
