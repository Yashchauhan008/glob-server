import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';
import env from '@/shared/configs/env.js';
import ServerError from '@/shared/utilities/server-error.class.js';
import sharp from 'sharp';
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp', ico: 'image/x-icon', tiff: 'image/tiff', pdf: 'application/pdf' };
const typeOf = (file: string) => TYPES[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';
const fileStoragePath = env.FILE_STORAGE_PATH;

// Uploaded files live in S3 under a Glob-only prefix; with no bucket configured they stay on disk (local dev).
export const useS3 = Boolean(env.AWS_S3_MEDIA_BUCKET);
const bucket = env.AWS_S3_MEDIA_BUCKET as string;
const prefix = env.AWS_S3_PREFIX.replace(/^\/+/, '').replace(/\/?$/, '/');
// the bucket is shared with other apps: never operate on its root
if (useS3 && prefix === '/') throw new Error('AWS_S3_PREFIX must not be empty when AWS_S3_MEDIA_BUCKET is set');
const s3 = useS3 ? new S3Client({ region: env.AWS_REGION, credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } }) : null;
const objectKey = (fileKey: string) => prefix + fileKey.replace(/^\/+/, '');

if (!useS3 && !fs.existsSync(fileStoragePath)) fs.mkdirSync(fileStoragePath, { recursive: true });

export const upload = async (filePath: string, newFileKey: string = '') => {
    const isFileExists = fs.existsSync(filePath);
    if (!isFileExists) throw new ServerError('File not found');
    const fileKey = path.join(newFileKey, path.basename(filePath));

    if (s3) {
        await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: objectKey(fileKey),
            Body: await fsp.readFile(filePath),
            ContentType: typeOf(filePath),
            CacheControl: 'public, max-age=31536000, immutable',
        }));
        await fsp.unlink(filePath);
        return fileKey;
    }

    if (!fs.existsSync(path.join(env.FILE_STORAGE_PATH, newFileKey)))
        fs.mkdirSync(path.join(env.FILE_STORAGE_PATH, newFileKey), { recursive: true });
    await fsp.copyFile(filePath, path.join(env.FILE_STORAGE_PATH, fileKey));
    await fsp.unlink(filePath);
    return fileKey;
};

export const deleteFile = async (fileKey: string) => {
    if (s3) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey(fileKey) }));
    // files uploaded before S3 was switched on still sit on disk
    const filePath = path.join(env.FILE_STORAGE_PATH, fileKey);
    if (fs.existsSync(filePath)) await fsp.unlink(filePath);
};

/** Stream one stored file (S3 first, then the old disk location). Returns null when it does not exist. */
export async function readFile(fileKey: string): Promise<{ body: NodeJS.ReadableStream; contentType: string; length?: number } | null> {
    if (s3) {
        try {
            const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey(fileKey) }));
            return { body: out.Body as unknown as NodeJS.ReadableStream, contentType: out.ContentType || 'application/octet-stream', length: out.ContentLength };
        } catch (e) {
            if ((e as { name?: string }).name !== 'NoSuchKey') throw e;
        }
    }
    const filePath = path.join(env.FILE_STORAGE_PATH, fileKey);
    if (!filePath.startsWith(path.resolve(env.FILE_STORAGE_PATH)) || !fs.existsSync(filePath)) return null;
    return { body: fs.createReadStream(filePath), contentType: typeOf(filePath), length: fs.statSync(filePath).size };
}

export async function convertToWebp(fileKey: string) {
    if (fileKey.endsWith('.webp')) return fileKey;
    const filePath = path.join(env.FILE_STORAGE_PATH, fileKey);
    const outputFileKey = path.basename(fileKey, path.extname(fileKey)) + '.webp';
    const outputFilePath = path.join(env.FILE_STORAGE_PATH, outputFileKey);
    if (!fs.existsSync(filePath)) throw new ServerError('File not found');
    await sharp(filePath).webp({ quality: 100 }).toFile(outputFilePath);
    return outputFileKey;
}

/**
 * Get all file keys from the file storage
 * @param dir - The directory to search for files
 * @param files - The array to store the file keys
 * @returns The array of file keys
 */
export async function getAllFileKeys(dir: string = env.FILE_STORAGE_PATH, files: string[] = []) {
    if (s3) {
        // only ever lists Glob's own prefix, never the rest of the bucket
        let token: string | undefined;
        do {
            const out = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
            for (const o of out.Contents ?? []) if (o.Key && !o.Key.endsWith('/')) files.push(o.Key.slice(prefix.length));
            token = out.NextContinuationToken;
        } while (token);
        return files;
    }

    const entries = await fsp.readdir(dir, { recursive: true, withFileTypes: true });

    for (const entry of entries) {
        if (entry.isFile()) {
            files.push(path.join(dir, entry.name).replace(env.FILE_STORAGE_PATH + '/', ''));
        }

        if (entry.isDirectory()) {
            await getAllFileKeys(path.join(env.FILE_STORAGE_PATH, entry.name), files);
        }
    }

    return files;
}
