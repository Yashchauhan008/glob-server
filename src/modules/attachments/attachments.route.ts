import { Router } from 'express';
import z from 'zod';
import withDatabase from '@/shared/utilities/with-database.js';
import { validate } from '@/shared/helpers/validation.helper.js';
import { notFound } from '@/shared/utilities/crud.js';
import { upload as imageUpload } from '@/shared/middlewares/multer/image-upload.js';
import { registerNewFile, hardDeleteFile } from '@/modules/file/file.service.js';
import { enrichLink } from '@/modules/attachments/link-preview.js';

const ENTITIES = ['idea', 'note', 'question', 'todo', 'event', 'lead'] as const;

const body = z.object({
    entity_type: z.enum(ENTITIES),
    entity_id: z.string().uuid(),
    kind: z.enum(['link', 'image']),
    url: z.string().trim().max(2000).optional(),
    file_id: z.string().uuid().optional(),
    title: z.string().trim().max(255).default(''),
});

const router = Router();

router.get('/', withDatabase(async (req, res, _n, db) => {
    const { type, id } = validate(z.object({ type: z.enum(ENTITIES), id: z.string().uuid() }), req.query);
    const items = await db.queryAll(
        `SELECT a.id, a.kind, a.url, a.title, a.thumb_url, a.created_at, a.owner_id, u.name AS owner_name
         FROM attachments a JOIN users u ON u.id = a.owner_id
         WHERE a.entity_type = $1 AND a.entity_id = $2 ORDER BY a.created_at`,
        [type, id],
    );
    res.json({ items });
}));

// images are stored as "saved" straight away so the pending-file cleanup never removes them
router.post('/upload', imageUpload.single('file'), withDatabase(async (req, res, _n, db) => {
    if (!req.file) return res.status(400).json({ message: 'Choose an image to upload' });
    const file = await registerNewFile(db, { filePath: req.file.path, _status: 'saved' });
    res.status(201).json({ file_id: file.id, url: file.url });
}));

router.post('/', withDatabase(async (req, res, _n, db) => {
    const b = validate(body, req.body);
    let url = b.url ?? '';
    let fileId: string | null = null;

    if (b.kind === 'link') {
        if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
        try { new URL(url); } catch { return res.status(400).json({ message: 'That does not look like a valid link' }); }
    } else {
        const file = b.file_id ? await db.queryOne('SELECT id, url FROM files WHERE id = $1', [b.file_id]) : null;
        if (!file) return res.status(400).json({ message: 'Upload the image first' });
        url = file.url; fileId = file.id;
    }

    const row = await db.queryOne(
        `INSERT INTO attachments (entity_type, entity_id, kind, url, title, file_id, owner_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [b.entity_type, b.entity_id, b.kind, url, b.title, fileId, req.user!.id],
    );
    res.status(201).json(row);
    // previews can be slow or blocked, so they never hold up saving; the UI picks them up shortly after
    if (b.kind === 'link') void enrichLink(row.id, url);
}));

// attach (or replace) a preview image by hand — Instagram, for one, refuses to give servers a thumbnail
router.post('/:id/thumbnail', imageUpload.single('file'), withDatabase(async (req, res, _n, db) => {
    if (!req.file) return res.status(400).json({ message: 'Choose an image' });
    const att = await db.queryOne("SELECT id, thumb_file_id FROM attachments WHERE id = $1 AND kind = 'link'", [req.params.id as string]);
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
