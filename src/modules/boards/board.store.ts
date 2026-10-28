import Database from '@/shared/helpers/database.helper.js';

/**
 * Live copy of the boards people are editing right now.
 * Edits are merged here as they arrive (so two people drawing at once never overwrite each other)
 * and written to Postgres a moment later instead of on every mouse move.
 */
export type El = { id: string; version: number; versionNonce: number; isDeleted?: boolean; updated?: number; [k: string]: unknown };
export type ImageRef = { url: string; file_id: string; mime: string };

type Entry = { elements: Map<string, El>; images: Record<string, ImageRef>; dirty: boolean; timer?: NodeJS.Timeout };

const FLUSH_MS = 1500;
const TOMBSTONE_MS = 24 * 3600 * 1000; // deleted shapes are forgotten after a day
const cache = new Map<string, Promise<Entry | null>>();

const load = async (id: string): Promise<Entry | null> => {
    const row = await Database.queryOne('SELECT elements, images FROM boards WHERE id = $1', [id]);
    if (!row) return null;
    return { elements: new Map((row.elements as El[]).map((e) => [e.id, e])), images: row.images as Record<string, ImageRef>, dirty: false };
};

const entry = (id: string) => {
    let p = cache.get(id);
    if (!p) { p = load(id); cache.set(id, p); }
    return p;
};

/** The newer version of an element wins; equal versions are settled by the nonce so every client agrees. */
const wins = (incoming: El, current?: El) =>
    !current || incoming.version > current.version || (incoming.version === current.version && incoming.versionNonce < current.versionNonce);

const valid = (e: unknown): e is El =>
    !!e && typeof e === 'object' && typeof (e as El).id === 'string' && typeof (e as El).version === 'number' && typeof (e as El).versionNonce === 'number';

export async function flush(id: string) {
    const p = cache.get(id);
    const e = p && (await p);
    if (!e) return;
    clearTimeout(e.timer); e.timer = undefined;
    if (!e.dirty) return;
    e.dirty = false;
    const now = Date.now();
    for (const [k, el] of e.elements) if (el.isDeleted && now - (el.updated ?? now) > TOMBSTONE_MS) e.elements.delete(k);
    await Database.query('UPDATE boards SET elements = $2::jsonb, images = $3::jsonb, updated_at = now() WHERE id = $1',
        [id, JSON.stringify([...e.elements.values()]), JSON.stringify(e.images)]);
}

const schedule = (id: string, e: Entry) => {
    e.dirty = true;
    if (!e.timer) e.timer = setTimeout(() => { flush(id).catch(() => {}); }, FLUSH_MS);
};

/** Merge edits in; returns only the ones that actually changed something, to pass on to the other people. */
export async function applyElements(id: string, incoming: unknown[]): Promise<El[]> {
    const e = await entry(id);
    if (!e) return [];
    const accepted: El[] = [];
    for (const el of incoming) {
        if (!valid(el) || !wins(el, e.elements.get(el.id))) continue;
        e.elements.set(el.id, el);
        accepted.push(el);
    }
    if (accepted.length) schedule(id, e);
    return accepted;
}

export async function setImage(id: string, fileId: string, ref: ImageRef) {
    const e = await entry(id);
    if (!e) return false;
    e.images[fileId] = ref;
    schedule(id, e);
    return true;
}

/** Current state: the live copy if someone is editing, otherwise straight from the database. */
export async function getState(id: string) {
    const live = cache.get(id);
    const e = live && (await live);
    if (e) return { elements: [...e.elements.values()], images: e.images };
    const row = await Database.queryOne('SELECT elements, images FROM boards WHERE id = $1', [id]);
    return row ? { elements: row.elements as El[], images: row.images as Record<string, ImageRef> } : null;
}

/** Called when the last person leaves: save and let go of the in-memory copy. */
export async function release(id: string) {
    await flush(id);
    cache.delete(id);
}

export const forget = (id: string) => {
    const p = cache.get(id);
    cache.delete(id);
    void p?.then((e) => e && clearTimeout(e.timer));
};

export async function flushAll() {
    await Promise.all([...cache.keys()].map((id) => flush(id).catch(() => {})));
}
