# MediBook HMS — project guide for Claude

**Start every task by reading this file and `docs/mvp-structure.md`.** The spec is the source of truth for scope, roles and tables. MediBook v1 (`../medibook`) is a design reference only — never modify it.

## The one rule: the visit is the centre of the data model
Every contact with the hospital creates a **visit** (encounter): a booked appointment, a walk-in, later an IPD admission or emergency. Clinical notes, vitals, orders, prescriptions and charges all hang from `visit_id`. Walk-ins are visits without an appointment — never create fake appointments. `Visit.type` is `OPD | WALK_IN | IPD | EMERGENCY` (IPD/EMERGENCY reserved for later releases).

```
patient → appointment (optional) → visit ─┬→ clinical_notes, vitals
                                          ├→ orders → order_results (LAB, RADIOLOGY, REFERRAL, MEDICATION)
                                          ├→ prescriptions → dispensations
                                          └→ charges → invoice_lines → invoices ← payment_allocations ← payments
```

## Stack (fixed — do not swap libraries)
- **Server** (`/server`): Node.js 20, Express, TypeScript (ESM, `tsx` for dev), Prisma + PostgreSQL 16, Redis 7 (`ioredis`), Socket.IO, Nodemailer, Zod, Vitest.
- **Web** (`/web`): React + Vite + TypeScript + React Router. **No UI framework.** Styles come from `web/src/theme/tokens.css` and the base components.
- **Infra**: `docker-compose.yml` runs Postgres (5432) and Redis (6379). `.env.example` lists every variable; real secrets live only in `.env` (git-ignored).

## Folder structure
```
/docs                 mvp-structure.md (spec)
/server
  prisma/schema.prisma  FULL schema for all table groups (people/access, scheduling, clinical, pharmacy, money, system)
  prisma/seed.ts
  src/index.ts          http server + Socket.IO bootstrap
  src/app.ts            express app, routes, error handler
  src/config/env.ts     Zod-validated env
  src/lib/              prisma, redis, mailer, socket, errors, validate, money
  src/modules/<name>/   auth, staff, patients, scheduling, reception, visits, orders,
                        pharmacy, billing, accounts, audit, notifications
                        each: <name>.service.ts, <name>.routes.ts, index.ts
/web
  src/theme/tokens.css  design tokens (only place colours/fonts/spacing are defined)
  src/theme/base.css    reset + base element styles
  src/components/       Button, Input, Select, Card, Badge, Table, Tabs, Modal, Toast, EmptyState, AppShell
  src/pages/            route pages (ComponentsDemo at /demo/components)
```

## Coding rules
1. **Module ownership**: each module owns its tables (listed in its `index.ts`). Other modules call its exported service — never query another module's tables with Prisma directly.
2. **Validation**: every request body/query/params is parsed with Zod (`validate()` middleware) before use.
3. **Errors**: throw `AppError(status, code, message)`; the central handler returns `{ error: { code, message } }`. Never leak stack traces.
4. **Money**: integer **paise** (`Int`), suffix `Paise` in code (`amountPaise`). Convert to rupees only for display (`formatPaise`).
5. **Time**: store all timestamps in **UTC** (`timestamptz`). Convert to IST only in the UI.
6. **Auth**: every route checks the user's role (and, for clinical data, the care relationship / break-glass). Every view of clinical data writes an `audit_logs` row.
7. **Secrets** only from env via `config/env.ts`; never commit `.env`.
8. **Live updates** go through Socket.IO rooms (e.g. `reception`, `dept:<id>`), emitted from services after commits.
9. **UI**: pages never hard-code colours, fonts or spacing — use `var(--token)` and base components. Status colours come from `Badge` tones.
10. Keep it MVP: don't build beyond the current task's scope.

## Roles
`SUPER_ADMIN, ADMIN, RECEPTIONIST, DOCTOR, LAB_TECH, RADIOLOGY_TECH, PHARMACIST, ACCOUNTS, PATIENT` (nurses come with inpatient). Staff log in with hospital-issued staff ID + password + email OTP; patients with email OTP. Access = role (screens) + care relationship (which patients) + break-glass (reason, admin alerted, audited). See the spec's role table for can/cannot.

## Key data rules
- Double-booking is impossible: partial unique index on `appointments(doctor_id, slot_start) WHERE status <> 'CANCELLED'` (raw SQL in the init migration).
- Order lifecycle: `ORDERED → SCHEDULED → IN_PROGRESS → COMPLETED → RESULT_READY` (or `CANCELLED`). Order has ordering doctor, target department, optional target doctor.
- `service_catalogue` items belong to a department and have a price; `charges` link visit + catalogue item + department → revenue by department.
- Payments ↔ invoices only through `payment_allocations`. Payments have an `idempotency_key` (safe retries).
- `audit_logs`: actor, action, entity, entity_id, patient_id, reason, ip, created_at.

## Commands
- `docker compose up -d` — Postgres + Redis
- `npm install` — installs all workspaces
- `npm run db:migrate` / `npm run db:seed`
- `npm run dev` — server (http://localhost:4000, `/api/health`) + web (http://localhost:5173)
- `npm test` — server tests (Vitest)
