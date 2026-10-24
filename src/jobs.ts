import { DatabaseBackupJob } from '@/cron.js';
import { FlushFilesJob, FlushUnTrackedFilesJob } from '@/modules/file/file.cron.js';
import Logger from '@/shared/configs/logger.js';

export function initializeJobs() {
    for (const job of [DatabaseBackupJob, FlushFilesJob, FlushUnTrackedFilesJob]) {
        Promise.resolve(job.start()).catch((error: Error) => {
            Logger.error(`Background job failed to start: ${error.message}`);
        });
    }
    Logger.info('Background Jobs initialized');
}
