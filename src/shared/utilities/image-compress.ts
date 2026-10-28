import fsp from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

// Only still raster formats; gif (may be animated), svg, ico and pdf are stored as uploaded.
const RASTER = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'heic', 'heif']);

export type CompressMode = 'avatar' | 'image';

// keep = the share of the original size we aim to end up with
const MODES: Record<CompressMode, { keep: number; max: number; square: boolean }> = {
    avatar: { keep: 0.5, max: 256, square: true }, // profile pictures: half the size, small square
    image: { keep: 0.2, max: 1920, square: false }, // everything else: 80% smaller
};

const QUALITIES = [82, 72, 62, 52, 42, 34];
const SCALES = [1, 0.8, 0.65, 0.5];

/**
 * Re-encode an uploaded image as WebP, lowering quality (then size) until it reaches the target.
 * Returns the path to use afterwards. If the file is not a plain image, can't be read, or would
 * not get smaller, the original path is returned untouched.
 */
export async function compressImage(filePath: string, mode: CompressMode): Promise<string> {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (!RASTER.has(ext)) return filePath;

    const { keep, max, square } = MODES[mode];
    try {
        const original = (await fsp.stat(filePath)).size;
        const target = original * keep;
        const source = sharp(filePath, { failOn: 'none' }).rotate(); // honour phone orientation; drops EXIF

        let best: Buffer | null = null;
        search: for (const scale of SCALES) {
            const side = Math.round(max * scale);
            const resized = square
                ? source.clone().resize(side, side, { fit: 'cover' })
                : source.clone().resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true });
            for (const quality of QUALITIES) {
                best = await resized.clone().webp({ quality, effort: 4 }).toBuffer();
                if (best.length <= target) break search;
            }
        }
        if (!best || best.length >= original) return filePath;

        const out = path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}.webp`);
        await fsp.writeFile(out, best);
        if (out !== filePath) await fsp.unlink(filePath);
        return out;
    } catch {
        return filePath;
    }
}
