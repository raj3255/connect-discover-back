import { Request, Response, NextFunction } from 'express';

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Always log the full error server-side for debugging.
  console.error('Error:', err);

  const statusCode = err.statusCode || 500;
  const isDev = process.env.NODE_ENV === 'development';

  // For server errors (5xx), never expose the raw error message to the client
  // in production — it can leak SQL, stack traces, or other internals. Client
  // errors (4xx) carry intentional, safe messages, so those are passed through.
  let message: string;
  if (statusCode >= 500) {
    message = isDev ? (err.message || 'Internal server error') : 'Internal server error';
  } else {
    message = err.message || 'Request failed';
  }

  res.status(statusCode).json({
    error: message,
    status: statusCode,
    ...(isDev && { stack: err.stack }),
  });
}