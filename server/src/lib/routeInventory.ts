import type { Router } from 'express';

/** One registered API route with the middleware facts the security test checks. */
export interface RouteInfo {
  method: string;
  path: string;
  guards: string[]; // 'auth' | 'role' | 'permission' | 'rateLimit', router-level first
  validates: { body: boolean; query: boolean; params: boolean };
}

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Layer[] }; handle: { guard?: string; validates?: Record<string, unknown> }; name?: string };

/** Walks each module router (mounted at /api/<name>) and lists its routes. */
export function routeInventory(routers: Record<string, Router>): RouteInfo[] {
  const out: RouteInfo[] = [];
  for (const [name, router] of Object.entries(routers)) {
    const routerGuards: string[] = [];
    for (const layer of (router as unknown as { stack: Layer[] }).stack) {
      if (!layer.route) {
        if (layer.handle.guard) routerGuards.push(layer.handle.guard);
        continue;
      }
      const handlers = layer.route.stack.map((l) => l.handle);
      const v = handlers.find((h) => h.validates)?.validates ?? {};
      for (const method of Object.keys(layer.route.methods).filter((m) => layer.route!.methods[m] && m !== '_all')) {
        out.push({
          method: method.toUpperCase(),
          path: `/api/${name}${layer.route.path === '/' ? '' : layer.route.path}`,
          guards: [...routerGuards, ...handlers.map((h) => h.guard).filter((g): g is string => !!g)],
          validates: { body: !!v.body, query: !!v.query, params: !!v.params },
        });
      }
    }
  }
  return out;
}
