import { Router } from 'express';
import withDatabase from '@/shared/utilities/with-database.js';

const router = Router();

router.get('/', withDatabase(async (req, res, _n, db) => {
    const rows = await db.queryAll(
        `SELECT * FROM (
           SELECT m.id, m.user_id, u.name, m.body, m.created_at FROM chat_messages m
           JOIN users u ON u.id = m.user_id WHERE m.team_id = $1 ORDER BY m.created_at DESC LIMIT 60
         ) t ORDER BY created_at`,
        [req.team!.id],
    );
    res.json({ items: rows });
}));

export default router;
