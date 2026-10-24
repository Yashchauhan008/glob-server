import Database from '@/shared/helpers/database.helper.js';
import { deleteFile, getAllFileKeys } from '@/shared/utilities/file.js';
import Logger from '@/shared/configs/logger.js';

export async function task() {
    const dbFiles = await Database.queryAll('SELECT id, key, _status FROM files');

    const dbFilesKeys = dbFiles.map((file) => file.key);
    const storageFiles = await getAllFileKeys();

    for (const file of storageFiles) {
        if (!dbFilesKeys.includes(file)) {
            await deleteFile(file);
            Logger.info(`Deleted file: ${file}`);
        }
    }

    Logger.info('Process completed');
}
