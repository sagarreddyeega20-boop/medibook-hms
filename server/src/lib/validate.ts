import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';

interface Schemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Zod request validation. Parsed values are stored on res.locals.valid
 * (Express 5 makes req.query read-only). ZodErrors reach the central error handler.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, res, next) => {
    res.locals.valid = {
      body: schemas.body ? schemas.body.parse(req.body) : req.body,
      query: schemas.query ? schemas.query.parse(req.query) : req.query,
      params: schemas.params ? schemas.params.parse(req.params) : req.params,
    };
    next();
  };
}
