import { Router } from 'express';
import withDatabase from '@/shared/utilities/with-database.js';
import { Controller as uploadFile } from '@/modules/file/controllers/upload-file.js';
import { Controller as uploadMultipleFiles } from '@/modules/file/controllers/upload-multiple-files.js';
import { readFile } from '@/shared/utilities/file.js';
import fileUpload from '@/shared/middlewares/multer/file-upload.js';

const router = Router();

router.route('/upload').post(fileUpload.single('file'), withDatabase(uploadFile));

router.route('/upload-multiple').post(fileUpload.array('files'), withDatabase(uploadMultipleFiles));

// files are streamed through the API (S3 or old disk copy), so the bucket itself stays private
router.get('/*key', async (req, res, next) => {
    try {
        const key = ([] as string[]).concat((req.params as unknown as { key: string | string[] }).key).join('/');
        if (!key || key.split('/').includes('..')) return res.status(404).json({ code: 'not_found', message: 'Not found' });
        const file = await readFile(key);
        if (!file) return res.status(404).json({ code: 'not_found', message: 'Not found' });
        res.set({
            'Content-Type': file.contentType,
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'X-Content-Type-Options': 'nosniff',
            ...(file.length ? { 'Content-Length': String(file.length) } : {}),
        });
        file.body.on('error', next);
        file.body.pipe(res);
    } catch (e) { next(e); }
});

router.use((_req, res) => {
    res.status(404).json({ code: 'not_found', message: 'Not found' });
});

export default router;
