import { RoomServiceClient } from 'livekit-server-sdk';
import env from '@/shared/configs/env.js';
import SocketService from '@/socket.js';
import { forgetAccess } from './access.service.js';

/** Throw someone out right now: their open pages lose the live connection and they drop out of the call. */
export async function kickUser(userId: string) {
    forgetAccess(userId);
    SocketService.io?.in(userId).disconnectSockets(true);
    if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return;
    try {
        await new RoomServiceClient(env.LIVEKIT_URL.replace(/^ws/, 'http'), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET)
            .removeParticipant('glob-live', userId);
    } catch { /* not in a call */ }
}
