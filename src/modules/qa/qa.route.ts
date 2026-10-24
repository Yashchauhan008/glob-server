import { Router } from 'express';
import z from 'zod';
import withDatabase from '@/shared/utilities/with-database.js';
import { validate } from '@/shared/helpers/validation.helper.js';
import { notFound } from '@/shared/utilities/crud.js';

const qBody = z.object({
    title: z.string().trim().min(1).max(500),
    body: z.string().trim().max(10000).default(''),
    idea_id: z.string().uuid().nullish(),
});
const aBody = z.object({ body: z.string().trim().min(1).max(10000) });
const router = Router();

router.get('/', withDatabase(async (_req, res, _n, db) => {
    res.json({
        items: await db.queryAll(
            `SELECT q.*, u.name AS owner_name, i.title AS idea_title,
                (SELECT count(*)::int FROM answers a WHERE a.question_id = q.id) AS answers_count
             FROM questions q JOIN users u ON u.id = q.owner_id LEFT JOIN ideas i ON i.id = q.idea_id
             ORDER BY (q.accepted_answer_id IS NULL) DESC, q.created_at DESC`,
        ),
    });
}));

router.post('/', withDatabase(async (req, res, _n, db) => {
    const b = validate(qBody, req.body);
    res.status(201).json(await db.queryOne(
        'INSERT INTO questions (owner_id,title,body,idea_id) VALUES ($1,$2,$3,$4) RETURNING *',
        [req.user!.id, b.title, b.body, b.idea_id ?? null],
    ));
}));

router.get('/:id', withDatabase(async (req, res, _n, db) => {
    const q = await db.queryOne(
        'SELECT q.*, u.name AS owner_name FROM questions q JOIN users u ON u.id = q.owner_id WHERE q.id = $1',
        [req.params.id as string],
    );
    if (!q) return notFound(res);
    const answers = await db.queryAll(
        `SELECT a.*, u.name AS owner_name FROM answers a JOIN users u ON u.id = a.owner_id
         WHERE a.question_id = $1 ORDER BY a.created_at`,
        [req.params.id as string],
    );
    res.json({ ...q, answers });
}));

router.post('/:id/answers', withDatabase(async (req, res, _n, db) => {
    const b = validate(aBody, req.body);
    res.status(201).json(await db.queryOne(
        'INSERT INTO answers (question_id, owner_id, body) VALUES ($1,$2,$3) RETURNING *',
        [req.params.id as string, req.user!.id, b.body],
    ));
}));

router.post('/:id/accept/:answerId', withDatabase(async (req, res, _n, db) => {
    const row = await db.queryOne(
        `UPDATE questions SET accepted_answer_id = $2
         WHERE id = $1 AND EXISTS (SELECT 1 FROM answers WHERE id = $2 AND question_id = $1) RETURNING *`,
        [req.params.id as string, req.params.answerId as string],
    );
    if (!row) return notFound(res);
    res.json(row);
}));

router.delete('/:id', withDatabase(async (req, res, _n, db) => {
    await db.query('DELETE FROM questions WHERE id = $1 AND owner_id = $2', [req.params.id as string, req.user!.id]);
    res.status(204).end();
}));

export default router;
