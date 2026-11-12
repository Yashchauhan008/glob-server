// src/types/express.d.ts';

declare global {
  namespace Express {
    interface Request {
      validatedQuery?: any;
      id?: string;
      user?: { id: string};
      team?: { id: string; role: 'owner' | 'member' };
    }
  }
}

export {};
