import path from 'path';
import { Router } from 'express';
import z from 'zod';
import withDatabase from '@/shared/utilities/with-database.js';
import { validate } from '@/shared/helpers/validation.helper.js';
import chatUpload from '@/shared/middlewares/multer/chat-upload.js';
import { registerNewFile } from '@/modules/file/file.service.js';
import { roleIn } from '@/modules/teams/team.service.js';
import Database from '@/shared/helpers/database.helper.js';
import {
    dmHistory, inbox, markDmRead, reactToMessage, markWorkspaceRead, sendDirectMessage, sendWorkspaceMessage, workspaceHistory,
} from '@/modules/messaging/messaging.service.js';

const router = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const page = z.object({
    before: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(40),
});

const who = async (id: string) => {
    const u = await Database.queryOne<{ id: string; name: string }>('SELECT id, name FROM users WHERE id = $1', [id]);
    if (!u) throw new Error('User not found');
    return u;
};

/** The other person must be a member of this workspace. */
router.param('userId', async (req, res, next, id) => {
    try {
        if (UUID.test(id) && id !== req.user!.id && (await roleIn(id, req.team!.id))) return next();
        res.status(404).json({ code: 'not_found', message: 'Not found' });
    } catch (e) { next(e); }
});

// ---- the chat list: workspace chat + conversations + everyone you can write to
router.get('/inbox', withDatabase(async (req, res) => {
    res.json(await inbox(req.user!.id, req.team!.id));
}));

// ---- pictures, voice notes, videos and documents
const IMAGE = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic', 'heif']);
const AUDIO = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'weba', 'amr']);
const VIDEO = new Set(['mp4', 'm4v', 'mov', 'mkv', 'avi', '3gp']);

router.post('/upload', chatUpload.single('file'), withDatabase(async (req, res, _n, db) => {
    if (!req.file) return res.status(400).json({ message: 'Choose a file to send' });
    const ext = path.extname(req.file.originalname).toLowerCase().slice(1);
    const mime = req.file.mimetype || '';
    let kind: 'image' | 'audio' | 'video' | 'file' = 'file';
    if (mime.startsWith('image/') || IMAGE.has(ext)) kind = 'image';
    else if (mime.startsWith('audio/') || AUDIO.has(ext)) kind = 'audio';
    else if (mime.startsWith('video/') || VIDEO.has(ext)) kind = 'video';
    else if (ext === 'webm') kind = 'video';
    const file = await registerNewFile(db, { filePath: req.file.path, _status: 'saved' });
    res.status(201).json({ file_id: file.id, url: file.url, name: req.file.originalname, mime, kind, size: req.file.size });
}));

// ---- reactions: one emoji per person per message; emoji null (or the same one again) takes it back
router.post('/react', withDatabase(async (req, res) => {
    const b = validate(z.object({ message_id: z.string().regex(UUID), emoji: z.string().max(16).nullable() }), req.body);
    try {
        res.json(await reactToMessage(await who(req.user!.id), req.team!.id, b.message_id, b.emoji));
    } catch (e) { res.status(400).json({ message: (e as Error).message }); }
}));

// ---- workspace chat
router.get('/', withDatabase(async (req, res) => {
    const q = validate(page, req.query);
    res.json(await workspaceHistory(req.team!.id, q.before ?? null, q.limit));
}));

router.post('/', withDatabase(async (req, res) => {
    try {
        res.status(201).json(await sendWorkspaceMessage(await who(req.user!.id), req.team!.id, req.body));
    } catch (e) { res.status(400).json({ message: (e as Error).message }); }
}));

router.post('/read', withDatabase(async (req, res) => {
    await markWorkspaceRead(req.user!.id, req.team!.id);
    res.status(204).end();
}));

// ---- personal chat
router.get('/dm/:userId', withDatabase(async (req, res) => {
    const q = validate(page, req.query);
    res.json(await dmHistory(req.user!.id, req.team!.id, req.params.userId as string, q.before ?? null, q.limit));
}));

router.post('/dm/:userId', withDatabase(async (req, res) => {
    try {
        res.status(201).json(await sendDirectMessage(await who(req.user!.id), req.team!.id, req.params.userId as string, req.body));
    } catch (e) { res.status(400).json({ message: (e as Error).message }); }
}));

router.post('/dm/:userId/read', withDatabase(async (req, res) => {
    await markDmRead(req.user!.id, req.team!.id, req.params.userId as string);
    res.status(204).end();
}));

export default router;
