import http from 'http';
import env from './shared/configs/env.js';
import app from './app.js';
import Logger from './shared/configs/logger.js';
import Socket from '@/socket.js';
import { initializeJobs } from './jobs.js';
import { flushAll } from '@/modules/boards/board.store.js';

const server = http.createServer(app);

Socket.init(server);

server.listen(env.PORT, () => {
    Logger.info(`Server is running on port ${env.PORT} in ${env.ENV} mode`);
});

initializeJobs();

// a deploy restarts the container: save whiteboard edits that are still waiting in memory first
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
        flushAll().finally(() => process.exit(0));
    });
}
