import path from 'path';
import { Router } from 'express';
import z from 'zod';
import withDatabase from '@/shared/utilities/with-database.js';
import { validate } from '@/shared/helpers/validation.helper.js';
import { notFound } from '@/shared/utilities/crud.js';
import { upload as imageUpload } from '@/shared/middlewares/multer/image-upload.js';
import fileUpload from '@/shared/middlewares/multer/file-upload.js';
import { registerNewFile, hardDeleteFile } from '@/modules/file/file.service.js';
import { enrichLink } from '@/modules/attachments/link-preview.js';
import Database from '@/shared/helpers/database.helper.js';
import { inTeam } from '@/modules/teams/team.scope.js';

const ENTITIES = ['idea', 'note', 'question', 'todo', 'event', 'lead'] as const;
const KINDS = ['link', 'image', 'text', 'video', 'document'] as const;

const VIDEO_HOST = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|dailymotion\.com)$/i;

function normalizeUrl(raw: string) {
    let url = raw.trim();
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    new URL(url);
    return url;
}

function kindForUrl(url: string, asked: (typeof KINDS)[number]) {
    if (asked === 'video' || asked === 'link') {
        try {
            const host = new URL(url).hostname.replace(/^www\./, '');
            if (VIDEO_HOST.test(host)) return 'video' as const;
        } catch { /* keep asked */ }
    }
    return asked;
}

const body = z.object({
    entity_type: z.enum(ENTITIES),
    entity_id: z.string().uuid(),
    kind: z.enum(KINDS),
    url: z.string().trim().max(2000).optional(),
    file_id: z.string().uuid().optional(),
    title: z.string().trim().max(255).default(''),
    body: z.string().trim().max(20000).default(''),
});

const router = Router();
router.param('id', inTeam('attachments'));

const PARENT: Record<(typeof ENTITIES)[number], string> = {
    idea: 'SELECT 1 AS ok FROM ideas WHERE id = $1 AND team_id = $2',
    note: 'SELECT 1 AS ok FROM idea_messages m JOIN ideas i ON i.id = m.idea_id WHERE m.id = $1 AND i.team_id = $2',
    question: 'SELECT 1 AS ok FROM questions WHERE id = $1 AND team_id = $2',
    todo: 'SELECT 1 AS ok FROM todos WHERE id = $1 AND team_id = $2',
    event: 'SELECT 1 AS ok FROM events WHERE id = $1 AND team_id = $2',
    lead: 'SELECT 1 AS ok FROM leads WHERE id = $1 AND team_id = $2',
};
const parentInTeam = async (type: (typeof ENTITIES)[number], id: string, teamId: string) =>
    !!(await Database.queryOne(PARENT[type], [id, teamId]));

router.get('/', withDatabase(async (req, res, _n, db) => {
    const { type, id } = validate(z.object({ type: z.enum(ENTITIES), id: z.string().uuid() }), req.query);
    const items = await db.queryAll(
        `SELECT a.id, a.kind, a.url, a.title, a.body, a.thumb_url, a.created_at, a.owner_id, u.name AS owner_name
         FROM attachments a JOIN users u ON u.id = a.owner_id
         WHERE a.entity_type = $1 AND a.entity_id = $2 AND a.team_id = $3 ORDER BY a.created_at`,
        [type, id, req.team!.id],
    );
    res.json({ items });
}));

router.post('/upload', imageUpload.single('file'), withDatabase(async (req, res, _n, db) => {
    if (!req.file) return res.status(400).json({ message: 'Choose an image to upload' });
    const file = await registerNewFile(db, { filePath: req.file.path, _status: 'saved' });
    res.status(201).json({ file_id: file.id, url: file.url, name: req.file.originalname });
}));

// PDFs, videos, docs — anything the browser can pick, up to the multer limit
router.post('/upload-file', fileUpload.single('file'), withDatabase(async (req, res, _n, db) => {
    if (!req.file) return res.status(400).json({ message: 'Choose a file to upload' });
    const file = await registerNewFile(db, { filePath: req.file.path, _status: 'saved' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const video = req.file.mimetype.startsWith('video/') || ['.mp4', '.webm', '.mov', '.m4v'].includes(ext);
    res.status(201).json({
        file_id: file.id,
        url: file.url,
        name: req.file.originalname,
        kind: video ? 'video' : 'document',
    });
}));

router.post('/', withDatabase(async (req, res, _n, db) => {
    const b = validate(body, req.body);
    if (!(await parentInTeam(b.entity_type, b.entity_id, req.team!.id))) return notFound(res);

    let url = '';
    let fileId: string | null = null;
    let kind = b.kind;
    let title = b.title;
    const note = b.body;

    if (kind === 'text') {
        if (!note) return res.status(400).json({ message: 'Type the reference note' });
        title = title || note.slice(0, 80);
    } else if (kind === 'link' || kind === 'video') {
        try { url = normalizeUrl(b.url ?? ''); } catch { return res.status(400).json({ message: 'That does not look like a valid link' }); }
        kind = kindForUrl(url, kind);
    } else {
        const file = b.file_id ? await db.queryOne('SELECT id, url FROM files WHERE id = $1', [b.file_id]) : null;
        if (!file) return res.status(400).json({ message: 'Upload the file first' });
        url = file.url as string;
        fileId = file.id as string;
        if (!title && b.url) title = b.url; // optional original filename passed as url/title by the client
    }

    const row = await db.queryOne(
        `INSERT INTO attachments (entity_type, entity_id, kind, url, title, body, file_id, owner_id, team_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [b.entity_type, b.entity_id, kind, url, title, note, fileId, req.user!.id, req.team!.id],
    );
    res.status(201).json(row);
    if (kind === 'link' || kind === 'video') void enrichLink(row.id, url);
}));

router.post('/:id/thumbnail', imageUpload.single('file'), withDatabase(async (req, res, _n, db) => {
    if (!req.file) return res.status(400).json({ message: 'Choose an image' });
    const att = await db.queryOne(
        "SELECT id, thumb_file_id FROM attachments WHERE id = $1 AND kind IN ('link', 'video')",
        [req.params.id as string],
    );
    if (!att) return notFound(res);
    const file = await registerNewFile(db, { filePath: req.file.path, _status: 'saved' });
    await db.query('UPDATE attachments SET thumb_url = $2, thumb_file_id = $3 WHERE id = $1', [att.id, file.url, file.id]);
    if (att.thumb_file_id) await hardDeleteFile(db, { id: att.thumb_file_id });
    res.json({ thumb_url: file.url });
}));

router.delete('/:id', withDatabase(async (req, res, _n, db) => {
    const row = await db.queryOne('DELETE FROM attachments WHERE id = $1 RETURNING file_id, thumb_file_id', [req.params.id as string]);
    if (!row) return notFound(res);
    for (const id of [row.file_id, row.thumb_file_id]) if (id) await hardDeleteFile(db, { id });
    res.status(204).end();
}));

export default router;
