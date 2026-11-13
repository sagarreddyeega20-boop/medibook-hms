/** Thin fetch wrapper. In dev, Vite proxies /api to the server, so relative URLs work. */
export interface ApiError {
  code: string;
  message: string;
  details?: { retryAfterSeconds?: number; attemptsRemaining?: number } & Record<string, unknown>;
}

export class ApiRequestError extends Error {
  constructor(public readonly status: number, public readonly error: ApiError) {
    super(error.message);
  }
}

/** Fired when an authenticated call gets 401 (idle timeout, revoked session); AuthProvider listens. */
export const UNAUTHORIZED_EVENT = 'mb:unauthorized';

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(path, {
    ...rest,
    method: rest.method ?? (json !== undefined ? 'POST' : 'GET'),
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    headers: { 'Content-Type': 'application/json', ...rest.headers },
    credentials: 'include',
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new ApiRequestError(res.status, body?.error ?? { code: 'HTTP_ERROR', message: res.statusText });
    if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: err.error.code }));
    throw err;
  }
  return body as T;
}

/** Message for a failed call, with field errors from Zod validation when present. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    const issues = err.error.details as unknown as { path: string; message: string }[] | undefined;
    if (err.error.code === 'VALIDATION_ERROR' && Array.isArray(issues) && issues[0]) return issues[0].message;
    return err.error.message;
  }
  return 'Could not reach the server. Check your connection and try again.';
}

export interface Health {
  status: 'ok' | 'degraded';
  services: { database: 'ok' | 'down'; redis: 'ok' | 'down' };
  time: string;
}

/** Health returns 503 with a body when degraded; read it either way. */
export async function getHealth(): Promise<Health> {
  const res = await fetch('/api/health');
  return (await res.json()) as Health;
}
