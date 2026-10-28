import Database from '@/shared/helpers/database.helper.js';
import Logger from '@/shared/configs/logger.js';
import SocketService from '@/socket.js';

const TICK_MS = 60_000;

/**
 * Counts how long each person has Glob open: once a minute, everyone with a live connection
 * gets the time that passed added to their total. Nothing to lose on a restart beyond the last minute.
 */
export function startLiveTimeCounter() {
    let last = Date.now();
    setInterval(async () => {
        const now = Date.now();
        const seconds = Math.min(Math.round((now - last) / 1000), 120); // a stalled tick never counts as hours
        last = now;
        try {
            const sockets = await SocketService.io?.fetchSockets();
            const ids = [...new Set((sockets ?? []).map((s) => s.data.user?.id as string | undefined).filter(Boolean))];
            if (ids.length) await Database.query("UPDATE users SET live_seconds = live_seconds + $2 WHERE id = ANY(string_to_array($1, ',')::uuid[])", [(ids as string[]).join(','), seconds]);
        } catch (e) {
            Logger.error(`Live time counter failed: ${(e as Error).message}`);
        }
    }, TICK_MS).unref();
}
