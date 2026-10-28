import { Router } from 'express';
import z from 'zod';
import withDatabase from '@/shared/utilities/with-database.js';
import { validate } from '@/shared/helpers/validation.helper.js';
import { notFound } from '@/shared/utilities/crud.js';
import { upload as imageUpload } from '@/shared/middlewares/multer/image-upload.js';
import { hardDeleteFile, registerNewFile } from '@/modules/file/file.service.js';
import SocketService from '@/socket.js';
import { forget, getState, setImage, type ImageRef } from './board.store.js';

const router = Router();
const uuid = z.string().uuid();

const LIST = `SELECT b.id, b.title, b.idea_id, i.title AS idea_title, b.owner_id, u.name AS owner_name, b.thumb_url, b.created_at, b.updated_at,
    (SELECT count(*)::int FROM jsonb_array_elements(b.elements) e WHERE coalesce((e->>'isDeleted')::boolean, false) = false) AS shapes
  FROM boards b JOIN users u ON u.id = b.owner_id LEFT JOIN ideas i ON i.id = b.idea_id`;

router.get('/', withDatabase(async (req, res, _n, db) => {
    const ideaId = typeof req.query.idea_id === 'string' ? validate(uuid, req.query.idea_id) : null;
    const items = await db.queryAll(`${LIST} WHERE ($1::uuid IS NULL OR b.idea_id = $1) ORDER BY b.updated_at DESC`, [ideaId]);
    res.json({ items });
}));

const create = z.object({ title: z.string().trim().max(200).default(''), idea_id: uuid.nullable().optional() });

router.post('/', withDatabase(async (req, res, _n, db) => {
    const b = validate(create, req.body);
    const row = await db.queryOne(
        'INSERT INTO boards (title, idea_id, owner_id) VALUES ($1, $2, $3) RETURNING id',
        [b.title || 'Untitled board', b.idea_id ?? null, req.user!.id],
    );
    res.status(201).json(row);
}));

router.get('/:id', withDatabase(async (req, res, _n, db) => {
    const id = validate(uuid, req.params.id);
    const meta = await db.queryOne(`${LIST} WHERE b.id = $1`, [id]);
    const state = meta && (await getState(id));
    if (!meta || !state) return notFound(res);
    res.json({ ...meta, ...state });
}));

const patch = z.object({ title: z.string().trim().min(1).max(200).optional(), idea_id: uuid.nullable().optional() });

router.patch('/:id', withDatabase(async (req, res, _n, db) => {
    const id = validate(uuid, req.params.id);
    const b = validate(patch, req.body);
    const row = await db.queryOne(
        `UPDATE boards SET title = COALESCE($2, title),
            idea_id = CASE WHEN $3::boolean THEN $4::uuid ELSE idea_id END, updated_at = now()
         WHERE id = $1 RETURNING id`,
        [id, b.title ?? null, b.idea_id !== undefined, b.idea_id ?? null],
    );
    if (!row) return notFound(res);
    const meta = await db.queryOne(`${LIST} WHERE b.id = $1`, [id]);
    SocketService.io?.to(`board:${id}`).emit('board:meta', { boardId: id, title: meta?.title, idea_id: meta?.idea_id, idea_title: meta?.idea_title });
    res.json(meta);
}));

router.delete('/:id', withDatabase(async (req, res, _n, db) => {
    const id = validate(uuid, req.params.id);
    const row = await db.queryOne('SELECT owner_id, images, thumb_file_id FROM boards WHERE id = $1', [id]);
    if (!row) return notFound(res);
    if (row.owner_id !== req.user!.id) return res.status(403).json({ message: 'Only the person who made this board can delete it' });
    forget(id);
    await db.query('DELETE FROM boards WHERE id = $1', [id]);
    // free the pictures in S3 as well
    const fileIds = [...Object.values(row.images as Record<string, ImageRef>).map((i) => i.file_id), row.thumb_file_id].filter(Boolean) as string[];
    for (const fid of fileIds) await hardDeleteFile(db, { id: fid });
    SocketService.io?.to(`board:${id}`).emit('board:deleted', { boardId: id });
    res.status(204).end();
}));

// a picture dropped onto the canvas: stored in S3 (compressed), and everyone on the board is told where to get it
router.post('/:id/images', imageUpload.single('file'), withDatabase(async (req, res, _n, db) => {
    const id = validate(uuid, req.params.id);
    const fileId = validate(z.string().min(1).max(100), req.body?.fileId);
    if (!req.file) return res.status(400).json({ message: 'Choose an image' });
    if (!(await db.queryOne('SELECT 1 AS ok FROM boards WHERE id = $1', [id]))) return notFound(res);
    const file = await registerNewFile(db, { filePath: req.file.path, _status: 'saved' });
    const ref: ImageRef = { url: file.url, file_id: file.id, mime: String(req.file.mimetype || 'image/webp') };
    await setImage(id, fileId, ref);
    SocketService.io?.to(`board:${id}`).emit('board:image', { boardId: id, fileId, ...ref });
    res.status(201).json(ref);
}));

// small preview for the boards list
router.post('/:id/thumbnail', imageUpload.single('file'), withDatabase(async (req, res, _n, db) => {
    const id = validate(uuid, req.params.id);
    if (!req.file) return res.status(400).json({ message: 'Choose an image' });
    const board = await db.queryOne('SELECT thumb_file_id FROM boards WHERE id = $1', [id]);
    if (!board) return notFound(res);
    const file = await registerNewFile(db, { filePath: req.file.path, _status: 'saved' });
    // not touching updated_at: a new preview is not an edit
    await db.query('UPDATE boards SET thumb_url = $2, thumb_file_id = $3 WHERE id = $1', [id, file.url, file.id]);
    if (board.thumb_file_id) await hardDeleteFile(db, { id: board.thumb_file_id as string });
    res.json({ thumb_url: file.url });
}));

export default router;
