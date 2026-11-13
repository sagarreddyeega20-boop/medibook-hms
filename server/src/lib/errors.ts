/** Throw this anywhere; the central error handler turns it into { error: { code, message } }. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message = 'Bad request', details?: unknown) {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }
  static unauthorized(message = 'Authentication required') {
    return new AppError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message = 'You do not have access to this resource') {
    return new AppError(403, 'FORBIDDEN', message);
  }
  static notFound(message = 'Not found') {
    return new AppError(404, 'NOT_FOUND', message);
  }
  static conflict(message = 'Conflict') {
    return new AppError(409, 'CONFLICT', message);
  }
}

/** True when a database write hit a unique index (Prisma P2002 or a raw Postgres 23505), e.g. the double-booking index. */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  return e.code === 'P2002' || e.code === '23505' || e.meta?.code === '23505' || /23505|unique constraint/i.test(e.message ?? '');
}
