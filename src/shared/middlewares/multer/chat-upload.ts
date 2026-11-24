import path from 'path';
import multer from 'multer';
import storage from './storage.js';
import ServerError from '@/shared/utilities/server-error.class.js';
import type { Request } from 'express';

// pictures, voice notes, videos and documents that can go into a chat
const ALLOWED = new Set([
    'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic', 'heif',
    'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'weba', 'amr', 'webm', '3gp',
    'mp4', 'm4v', 'mov', 'mkv', 'avi',
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'json', 'zip', 'rtf', 'md',
]);

const chatUpload = multer({
    storage,
    limits: { fileSize: 60 * 1024 * 1024, files: 1 }, // 60 MB: enough for a short video
    fileFilter: (_req: Request, file: Express.Multer.File, cb: (error: Error | null, accept: boolean) => void) => {
        const ext = path.extname(file.originalname).toLowerCase().slice(1);
        if (ALLOWED.has(ext)) cb(null, true);
        else cb(new ServerError('ERROR', 'That file type cannot be sent in chat'), false);
    },
});

export default chatUpload;
