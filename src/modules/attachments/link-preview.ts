import dns from 'dns/promises';
import fs from 'fs/promises';
import net from 'net';
import path from 'path';
import { v7 as uuidv7 } from 'uuid';
import Database from '@/shared/helpers/database.helper.js';
import Logger from '@/shared/configs/logger.js';
import { registerNewFile } from '@/modules/file/file.service.js';

const UA = 'Mozilla/5.0 (compatible; GlobBot/1.0; +https://glob.yashchauhan.pro) facebookexternalhit/1.1';
const MAX_HTML = 1_500_000;
const MAX_IMAGE = 5 * 1024 * 1024;

function isPrivate(ip: string): boolean {
    if (net.isIPv6(ip)) {
        const v = ip.toLowerCase();
        return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
    }
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

/** Only public http(s) hosts — this server must never be steered at its own network. */
async function assertPublic(raw: string): Promise<URL> {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) throw new Error('bad protocol');
    if (url.port && !['80', '443'].includes(url.port)) throw new Error('bad port');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw new Error('private address');
    return url;
}

async function safeFetch(raw: string, accept: string, maxBytes: number, timeoutMs = 7000): Promise<{ res: Response; buf: Buffer; url: string }> {
    let current = raw;
    for (let hop = 0; hop < 4; hop++) {
        const url = await assertPublic(current);
        const res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': UA, accept }, signal: AbortSignal.timeout(timeoutMs) });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            current = new URL(res.headers.get('location')!, url).toString();
            continue;
        }
        if (!res.ok) throw new Error(`status ${res.status}`);
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
            size += c.length;
            if (size > maxBytes) break; // enough of the page for its <head>; images over the cap are rejected below
            chunks.push(Buffer.from(c));
        }
        return { res, buf: Buffer.concat(chunks), url: url.toString() };
    }
    throw new Error('too many redirects');
}

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const meta = (html: string, names: string[]) => {
    for (const n of names) {
        const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']+)["']`, 'i'))
            ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${n}["']`, 'i'));
        if (m) return decode(m[1]);
    }
    return '';
};

type Preview = { title: string; image: string };

async function previewFor(raw: string): Promise<Preview> {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, '');

    const yt = host === 'youtu.be' ? u.pathname.slice(1)
        : /(^|\.)youtube\.com$/.test(host) ? (u.searchParams.get('v') ?? u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{6,})/)?.[1] ?? '') : '';
    if (yt) {
        let title = '';
        try { title = (await (await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(raw)}&format=json`, { signal: AbortSignal.timeout(5000) })).json() as any).title ?? ''; } catch { /* title is optional */ }
        return { title, image: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` };
    }
    if (/(^|\.)tiktok\.com$/.test(host)) {
        try {
            const j = await (await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(raw)}`, { signal: AbortSignal.timeout(5000) })).json() as any;
            if (j.thumbnail_url) return { title: j.title ?? '', image: j.thumbnail_url };
        } catch { /* fall through to generic */ }
    }
    const { buf, url } = await safeFetch(raw, 'text/html,application/xhtml+xml', MAX_HTML);
    const html = buf.toString('utf8');
    const img = meta(html, ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src']);
    const title = meta(html, ['og:title', 'twitter:title']) || decode(html.match(/<title[^>]*>([^<]+)/i)?.[1] ?? '');
    // login-wall pages (Instagram) answer with just their own name; that is not a useful title
    return { title: title.toLowerCase() === host.split('.')[0] ? '' : title, image: img ? new URL(img, url).toString() : '' };
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

/** Download a remote image into our own storage so previews survive CDN expiry and hotlink blocking. */
async function saveRemoteImage(image: string): Promise<{ id: string; url: string } | null> {
    const { res, buf } = await safeFetch(image, 'image/*', MAX_IMAGE, 9000);
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const ext = EXT[type];
    if (!ext || !buf.length || buf.length >= MAX_IMAGE) return null;
    const tmp = path.join(process.cwd(), 'tmp', `${uuidv7()}.${ext}`);
    await fs.mkdir(path.dirname(tmp), { recursive: true });
    await fs.writeFile(tmp, buf);
    const db = await Database.getConnection();
    try {
        const file = await registerNewFile(db, { filePath: tmp, _status: 'saved' });
        return { id: file.id, url: file.url };
    } finally { db.release(); }
}

/** Background job: fill in title + thumbnail for a link attachment. Never throws. */
export async function enrichLink(attachmentId: string, rawUrl: string) {
    try {
        const p = await previewFor(rawUrl);
        const thumb = p.image ? await saveRemoteImage(p.image).catch(() => null) : null;
        await Database.query(
            `UPDATE attachments SET title = CASE WHEN title = '' THEN $2 ELSE title END,
                    thumb_url = $3, thumb_file_id = $4
             WHERE id = $1`,
            [attachmentId, p.title.slice(0, 255), thumb?.url ?? null, thumb?.id ?? null],
        );
    } catch (e) {
        Logger.info(`link preview skipped for ${rawUrl}: ${(e as Error).message}`);
    }
}
