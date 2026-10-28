import dotenv from 'dotenv';
import path from 'path';
import z from 'zod';

dotenv.config({
    path: path.join(process.cwd(), '.env'),
    override: true,
});

const envSchema = z.object({
    ENV: z.enum(['development', 'production', 'stage']).default('development'),
    PORT: z.coerce.number().int().positive().max(65535).default(3007),
    SERVICE_NAME: z.string().min(1).max(255).default('Boilerplate'),

    // Authentication
    JWT_SECRET: z.string().min(5).max(255),
    GOOGLE_CLIENT_ID: z.string().optional(),
    // the one person who decides who may sign in (invites, block, remove). Always allowed in.
    ROOT_EMAIL: z.string().trim().toLowerCase().optional(),
    // where the "Join the team" button in invite emails points
    APP_URL: z.string().url().default('https://glob.yashchauhan.pro'),

    // Logging
    CONSOLE_LOG_LEVEL: z
        .enum(['false', 'error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'])
        .default('info'),
    FILE_LOG_LEVEL: z
        .enum(['false', 'error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'])
        .default('info'),

    // File Storage
    FILE_STORAGE_ENDPOINT: z.url().default('http://localhost:3007/files'),
    FILE_STORAGE_PATH: z.string().min(3).max(255).default(path.join(process.cwd(), 'files')),

    // Database
    DATABASE_URL: z.url(),

    // Redis
    REDIS_URL: z.string().url().default('redis://localhost:6379'),

    // Voice / video (LiveKit)
    LIVEKIT_URL: z.string().optional(),
    LIVEKIT_API_KEY: z.string().optional(),
    LIVEKIT_API_SECRET: z.string().optional(),

    // SMTP
    SMTP_HOST: z.string(),
    SMTP_PORT: z.coerce.number().int().positive().max(65535),
    SMTP_USER: z.string(),
    SMTP_PASSWORD: z.string(),
    MAIL_FROM: z.string().optional(),

    // AWS
    AWS_REGION: z.string(),
    AWS_ACCESS_KEY_ID: z.string(),
    AWS_SECRET_ACCESS_KEY: z.string(),
    AWS_S3_BACKUP_BUCKET: z.string(),
    // uploaded files go here when set; otherwise they stay on local disk (FILE_STORAGE_PATH)
    AWS_S3_MEDIA_BUCKET: z.string().optional(),
    AWS_S3_PREFIX: z.string().default('glob/'),
});

const { data: env, error } = envSchema.safeParse(process.env);

if (error) throw new Error(`Invalid ENV options: ${error.message}`);

export default env;
