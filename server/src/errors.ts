import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

/** Every API error leaves the server as { error: { code, message, details? } }. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Sign in first.') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have access to this.') => new AppError(403, 'forbidden', message);
export const notFound = (message = 'Not found.') => new AppError(404, 'not_found', message);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'conflict', message, details);

export function errorBody(code: string, message: string, details?: unknown) {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError | ZodError | Error, request, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send(errorBody(err.code, err.message, err.details));
    }
    if (err instanceof ZodError) {
      const details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      return reply.status(400).send(errorBody('validation_error', 'Some fields are not valid.', details));
    }
    const fe = err as FastifyError;
    if (fe.validation) {
      return reply.status(400).send(errorBody('validation_error', fe.message));
    }
    if (fe.code === 'FST_REQ_FILE_TOO_LARGE' || fe.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send(errorBody('too_large', 'The upload is too large.'));
    }
    if (fe.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.status(415).send(errorBody('unsupported_media_type', fe.message));
    }
    if (fe.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || fe.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || err instanceof SyntaxError) {
      return reply.status(400).send(errorBody('bad_request', 'The request body is not valid JSON.'));
    }
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      return reply.status(fe.statusCode).send(errorBody(fe.code ?? 'bad_request', fe.message));
    }
    request.log.error({ err }, 'unhandled error');
    return reply.status(500).send(errorBody('internal_error', 'Something went wrong on the server.'));
  });
}
