import type { NextFunction, Request, Response } from 'express';

// Reflect the calling origin and finish preflight here, before any route or
// auth middleware can answer. A 401/404 without these headers is reported by
// the browser as a CORS failure, so the real response never surfaces.
export default function allowBrowserOrigin(req: Request, res: Response, next: NextFunction) {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin.length > 0) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
        const requested = req.headers['access-control-request-headers'];
        res.setHeader(
            'Access-Control-Allow-Headers',
            typeof requested === 'string' && requested.length > 0
                ? requested
                : 'Content-Type, Authorization',
        );
    }

    if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
    }

    next();
}
