/** Thin fetch wrapper. In dev, Vite proxies /api to the server, so relative URLs work. */
export interface ApiError {
  code: string;
  message: string;
}

export class ApiRequestError extends Error {
  constructor(public readonly status: number, public readonly error: ApiError) {
    super(error.message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    credentials: 'include',
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiRequestError(res.status, body?.error ?? { code: 'HTTP_ERROR', message: res.statusText });
  }
  return body as T;
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
