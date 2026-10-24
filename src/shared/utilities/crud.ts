import type { DatabaseClient } from '@/shared/helpers/database.helper.js';

/** Partial UPDATE of `table` from the defined keys in `data`; returns the row (or null). */
export async function patchRow(
    db: DatabaseClient,
    table: string,
    id: string,
    data: Record<string, unknown>,
) {
    const keys = Object.keys(data).filter((k) => data[k] !== undefined);
    if (!keys.length) return db.queryOne(`SELECT * FROM ${table} WHERE id = $1`, [id]);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    return db.queryOne(
        `UPDATE ${table} SET ${sets}, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, ...(keys.map((k) => data[k]) as any[])],
    );
}

export function notFound(res: import('express').Response) {
    return res.status(404).json({ code: 'not_found', message: 'Not found' });
}
