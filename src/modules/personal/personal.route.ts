import { Router } from 'express';
import z from 'zod';
import withDatabase from '@/shared/utilities/with-database.js';
import { validate } from '@/shared/helpers/validation.helper.js';
import { notFound } from '@/shared/utilities/crud.js';
import { makePinsRouter } from '@/modules/pins/pins.route.js';

// A person's own space. Nothing here belongs to a team, and every query is limited to the signed-in person.
const router = Router();

/** Account details and a few numbers for the workspaces page. */
router.get('/overview', withDatabase(async (req, res, _n, db) => {
    const me = req.user!.id;
    const account = await db.queryOne(
        `SELECT id, name, email, avatar_url, created_at, last_login_at, prev_login_at, login_count,
                (SELECT count(*)::int FROM team_members m WHERE m.user_id = u.id) AS workspaces
         FROM users u WHERE id = $1`,
        [me],
    );
    const counts = await db.queryOne(
        `SELECT (SELECT count(*)::int FROM personal_ideas WHERE owner_id = $1) AS ideas,
                (SELECT count(*)::int FROM personal_todos WHERE owner_id = $1 AND NOT done) AS open_tasks,
                (SELECT count(*)::int FROM personal_todos WHERE owner_id = $1 AND NOT done AND due_date IS NOT NULL AND due_date <= current_date) AS tasks_due,
                (SELECT count(*)::int FROM pins WHERE owner_id = $1 AND team_id IS NULL) AS pins`,
        [me],
    );
    res.json({ account, counts });
}));

// ---- ideas ----
const IDEA_STATUSES = ['idea', 'planning', 'building', 'paused', 'dropped', 'shipped'] as const;
const idea = z.object({
    title: z.string().trim().min(1).max(255),
    description: z.string().trim().max(10000).default(''),
    status: z.enum(IDEA_STATUSES).default('idea'),
});

router.get('/ideas', withDatabase(async (req, res, _n, db) => {
    res.json({ items: await db.queryAll('SELECT * FROM personal_ideas WHERE owner_id = $1 ORDER BY created_at DESC', [req.user!.id]) });
}));
router.post('/ideas', withDatabase(async (req, res, _n, db) => {
    const b = validate(idea, req.body);
    res.status(201).json(await db.queryOne(
        'INSERT INTO personal_ideas (owner_id, title, description, status) VALUES ($1,$2,$3,$4) RETURNING *',
        [req.user!.id, b.title, b.description, b.status],
    ));
}));
router.patch('/ideas/:id', withDatabase(async (req, res, _n, db) => {
    const b = validate(idea.partial(), req.body);
    const row = await db.queryOne(
        `UPDATE personal_ideas SET title = COALESCE($3, title), description = COALESCE($4, description), status = COALESCE($5, status), updated_at = now()
         WHERE id = $1 AND owner_id = $2 RETURNING *`,
        [req.params.id as string, req.user!.id, b.title ?? null, b.description ?? null, b.status ?? null],
    );
    if (!row) return notFound(res);
    res.json(row);
}));
router.delete('/ideas/:id', withDatabase(async (req, res, _n, db) => {
    await db.query('DELETE FROM personal_ideas WHERE id = $1 AND owner_id = $2', [req.params.id as string, req.user!.id]);
    res.status(204).end();
}));

// ---- tasks ----
const todo = z.object({
    title: z.string().trim().min(1).max(500),
    done: z.boolean().default(false),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

router.get('/todos', withDatabase(async (req, res, _n, db) => {
    res.json({ items: await db.queryAll('SELECT * FROM personal_todos WHERE owner_id = $1 ORDER BY done, due_date NULLS LAST, created_at DESC', [req.user!.id]) });
}));
router.post('/todos', withDatabase(async (req, res, _n, db) => {
    const b = validate(todo, req.body);
    res.status(201).json(await db.queryOne(
        'INSERT INTO personal_todos (owner_id, title, done, due_date) VALUES ($1,$2,$3,$4) RETURNING *',
        [req.user!.id, b.title, b.done, b.due_date ?? null],
    ));
}));
router.patch('/todos/:id', withDatabase(async (req, res, _n, db) => {
    const b = validate(todo.partial(), req.body) as { title?: string; done?: boolean; due_date?: string | null };
    const row = await db.queryOne(
        `UPDATE personal_todos SET title = COALESCE($3, title), done = COALESCE($4, done),
            due_date = CASE WHEN $5::boolean THEN $6::date ELSE due_date END, updated_at = now()
         WHERE id = $1 AND owner_id = $2 RETURNING *`,
        [req.params.id as string, req.user!.id, b.title ?? null, b.done ?? null, b.due_date !== undefined, b.due_date ?? null],
    );
    if (!row) return notFound(res);
    res.json(row);
}));
router.delete('/todos/:id', withDatabase(async (req, res, _n, db) => {
    await db.query('DELETE FROM personal_todos WHERE id = $1 AND owner_id = $2', [req.params.id as string, req.user!.id]);
    res.status(204).end();
}));

// ---- dashboard blocks: pasted HTML that runs in a sandbox on the front end, with its saved data kept here ----
const MAX_HTML = 300_000;
const MAX_DATA = 500_000;
const widget = z.object({
    title: z.string().trim().min(1).max(120).default('Untitled block'),
    html: z.string().max(MAX_HTML, 'That code is too long (300 KB at most)'),
});
// what a block stored with localStorage: names to text values, nothing else
const widgetData = z.record(z.string().max(200), z.string()).refine((d) => JSON.stringify(d).length <= MAX_DATA, 'Saved data is too large (500 KB at most)');

router.get('/widgets', withDatabase(async (req, res, _n, db) => {
    res.json({ items: await db.queryAll('SELECT id, title, html, data, position, created_at, updated_at FROM personal_widgets WHERE owner_id = $1 ORDER BY position, created_at', [req.user!.id]) });
}));
router.post('/widgets', withDatabase(async (req, res, _n, db) => {
    const b = validate(widget, req.body);
    res.status(201).json(await db.queryOne(
        `INSERT INTO personal_widgets (owner_id, title, html, position)
         VALUES ($1,$2,$3, coalesce((SELECT max(position) + 1 FROM personal_widgets WHERE owner_id = $1), 0)) RETURNING *`,
        [req.user!.id, b.title, b.html],
    ));
}));
router.patch('/widgets/:id', withDatabase(async (req, res, _n, db) => {
    const b = validate(widget.partial(), req.body);
    const row = await db.queryOne(
        'UPDATE personal_widgets SET title = COALESCE($3, title), html = COALESCE($4, html), updated_at = now() WHERE id = $1 AND owner_id = $2 RETURNING *',
        [req.params.id as string, req.user!.id, b.title ?? null, b.html ?? null],
    );
    if (!row) return notFound(res);
    res.json(row);
}));
/** The block's saved data. Replaces the whole object, since the block always sends everything it has. */
router.put('/widgets/:id/data', withDatabase(async (req, res, _n, db) => {
    const { data } = validate(z.object({ data: widgetData }), req.body) as { data: Record<string, string> };
    const row = await db.queryOne(
        'UPDATE personal_widgets SET data = $3::jsonb WHERE id = $1 AND owner_id = $2 RETURNING id',
        [req.params.id as string, req.user!.id, JSON.stringify(data)],
    );
    if (!row) return notFound(res);
    res.status(204).end();
}));
router.delete('/widgets/:id', withDatabase(async (req, res, _n, db) => {
    await db.query('DELETE FROM personal_widgets WHERE id = $1 AND owner_id = $2', [req.params.id as string, req.user!.id]);
    res.status(204).end();
}));

router.use('/pins', makePinsRouter('personal'));

export default router;
