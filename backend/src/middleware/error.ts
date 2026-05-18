import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { logger } from '../logger.js';
import { AppError, ErrorCodes, type ApiError } from '../types.js';

export function notFoundHandler(_req: Request, res: Response): void {
  const body: { error: ApiError } = {
    error: { code: ErrorCodes.NOT_FOUND, message: 'Resource not found' },
  };
  res.status(404).json(body);
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    const body: { error: ApiError } = {
      error: { code: err.code, message: err.message, details: err.details },
    };
    res.status(err.status).json(body);
    return;
  }

  if (err instanceof ZodError) {
    const body: { error: ApiError } = {
      error: {
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Request validation failed',
        details: err.issues,
      },
    };
    res.status(400).json(body);
    return;
  }

  logger.error({ err, path: req.path, method: req.method }, 'unhandled error');
  const body: { error: ApiError } = {
    error: { code: ErrorCodes.INTERNAL_ERROR, message: 'Internal server error' },
  };
  res.status(500).json(body);
}
