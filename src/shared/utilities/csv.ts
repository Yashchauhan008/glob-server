export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
    const esc = (v: unknown) => {
        if (v === null || v === undefined) return '';
        const s = v instanceof Date ? v.toISOString() : String(v);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n');
}

/** RFC4180-ish parser; returns array of objects keyed by lowercase trimmed header. */
export function parseCsv(text: string): Record<string, string>[] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cur = '';
    let quoted = false;
    const src = text.replace(/^﻿/, '');
    for (let i = 0; i < src.length; i++) {
        const c = src[i]!;
        if (quoted) {
            if (c === '"' && src[i + 1] === '"') { cur += '"'; i++; }
            else if (c === '"') quoted = false;
            else cur += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { row.push(cur); cur = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && src[i + 1] === '\n') i++;
            row.push(cur); cur = '';
            rows.push(row); row = [];
        } else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
    const header = (nonEmpty.shift() || []).map((h) => h.trim().toLowerCase());
    return nonEmpty.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}
