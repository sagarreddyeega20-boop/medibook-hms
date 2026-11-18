import type { RequestHandler } from 'express';
import { z, type ZodTypeAny } from 'zod';

/** Body schema for action endpoints that take no input (POST /:id/start etc.): nothing, or an empty object. */
export const noBody = z.object({}).strict().optional();

interface Schemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Zod request validation. Parsed values are stored on res.locals.valid
 * (Express 5 makes req.query read-only). ZodErrors reach the central error handler.
 */
export function validate(schemas: Schemas): RequestHandler & { validates: Schemas } {
  const handler: RequestHandler = (req, res, next) => {
    res.locals.valid = {
      body: schemas.body ? schemas.body.parse(req.body) : req.body,
      query: schemas.query ? schemas.query.parse(req.query) : req.query,
      params: schemas.params ? schemas.params.parse(req.params) : req.params,
    };
    next();
  };
  // Tagged so the security test can check that every route parses its params, query and body with Zod.
  return Object.assign(handler, { validates: schemas });
}
