import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { JWTPayload } from '../types/index.js';
import { config } from '../config/env.js';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      user?: JWTPayload;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, config.JWT_SECRET) as JWTPayload;
    req.user = decoded;
    req.userId = decoded.userId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export function generateTokens(userId: string, email: string) {
  const accessToken = jwt.sign(
    { userId, email },
    config.JWT_SECRET,
    { expiresIn: config.JWT_EXPIRY } as any
  );

  const refreshToken = jwt.sign(
    { userId, email },
    config.JWT_REFRESH_SECRET,
    { expiresIn: config.JWT_REFRESH_EXPIRY } as any
  );

  return { accessToken, refreshToken };
}