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
- **Infra**: `docker-compose.yml` runs Postgres (host port 5434) and Redis (host port 6380) — non-default ports so it can run beside other local projects. `.env.example` lists every variable; real secrets live only in `.env` (git-ignored).

## Folder structure
```
/docs                 mvp-structure.md (spec), ui-reference/ (v1 screenshots + design PDF)
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
  src/components/       base: Button, Input, Textarea, Select, Card, Badge, Table, Tabs, Modal, Toast, EmptyState, Icon
                        layouts + v1 patterns: see "UI rules" below (components.css = base, patterns.css = v1 patterns)
  src/lib/format.ts     formatPaise, initials, greeting
  src/pages/            route pages; pages/demo/ = reference rebuilds of every v1 screen
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
9. **UI**: follow the **UI rules** section below. Pages never hard-code colours, fonts or spacing — use `var(--token)` and the components. Status colours come from `Badge`.
10. Keep it MVP: don't build beyond the current task's scope.

## UI rules — every screen must look like MediBook v1
The HMS keeps the v1 look: layout and patterns, not just colours. **Before building a screen, open the matching reference in `docs/ui-reference/` and the demo page that rebuilds it.**

1. **Reuse the components.** Every new screen is composed from `web/src/components` (import from `../components`). Don't write page-level CSS for something a component already does. If a screen needs a new pattern, add it as a component in the v1 style (tokens only, `mb-` prefix, styles in `patterns.css`), add it to a demo page, then use it.
2. **Staff screens** (admin, reception, doctor, lab, radiology, pharmacy, accounts) use the **v1 doctor-dashboard layout**:
   `AppShell` (dark sidebar: logo tile, pill nav, profile card with logout) → header with **greeting + subtitle**, **search** and primary action → `StatGrid` of 4 `StatCard`s → `DashGrid` with the **main table** (`Card flush` + `Table`) on the left and the **right side panel** (e.g. `NowConsultingCard`, `AvailabilityChips`, detail cards) on the right. Reference: `/demo/staff`.
3. **Patient screens** use the **v1 patient layout**: `PatientLayout` with `PatientNavbar` (teal "+" logo tile, "MediBook" wordmark, right-aligned links, teal filled CTA) on the light `--bg` page, content in cards; `PatientGrid` for banner + main + 300px side column. Reference: `/demo/patient`, `/demo/patient/appointments`, `/demo/patient/payment`, `/demo/patient/chat`.
4. **Status badges** always come from `<Badge status="…" />` so a status has one colour everywhere (v1: Completed/Confirmed green, Checked in blue, Booked grey, Cancelled/Awaiting orange, Awaiting payment yellow). Add new statuses to `STATUS_TONES` in `Badge.tsx`.
5. **Money** shows via `formatPaise`; amounts right-aligned with tabular numbers.
6. Every screen must work at **phone width** (375px) with no sideways page scroll — tables scroll inside their card. Check it in the browser before calling a screen done.

| v1 pattern | Component(s) | Demo |
|---|---|---|
| Top navbar (logo tile, wordmark, links, teal CTA) | `PatientNavbar`, `PatientLayout`, `LogoTile` | `/demo/patient` |
| Dark hero banner with stat numbers | `HeroBanner` | `/demo/patient/appointments` |
| Appointment card (date tile, status, Reschedule/Cancel) | `AppointmentCard`, `DateTile` | `/demo/patient/appointments` |
| Side cards ("Doctors you've consulted", "Ask the assistant") | `SideCard`, `PersonList` | `/demo/patient/appointments` |
| Dark sidebar + greeting/search header | `AppShell`, `DashGrid` | `/demo/staff` |
| Stat cards | `StatGrid`, `StatCard` | `/demo/staff` |
| Schedule table with status badges, current row highlight | `Table` (`isCurrent`), `PersonCell`, `Badge` | `/demo/staff` |
| "Now consulting" side card | `NowConsultingCard` | `/demo/staff` |
| Availability day chips | `AvailabilityChips` | `/demo/staff` |
| Chat bubbles, slot chips, doctor cards, confirmation | `ChatPanel`, `ChatMessage`, `ChatBlock`, `DoctorSlotCard`, `SlotChip`, `ConfirmationCard`, `QuickReplies`, `ChatAppointment`, `TypingIndicator` | `/demo/patient`, `/demo/patient/chat` |
| Payment page (order summary + method cards) | `OrderSummary`, `PaymentMethodCard`, `OptionTiles`, `OrDivider`, `TrustNote`, `Button size="lg"` | `/demo/patient/payment` |
| Speciality pills | `Pill` | `/demo/patient` |

Not yet a component: the v1 login / sign-up page (centred card with a Patient | Doctor segmented switch, `02-login.png`, `03-signup.png`). Build it as a component when the auth screens are built.

### Reference screenshots (`docs/ui-reference/`)
Captured from MediBook v1 running on its seed data, at 1440px wide (07 at 390px):

| File | Screen |
|---|---|
| `01-home.png` | Patient home (signed out): hero, Patient ID card, speciality pills, chat |
| `02-login.png` | Login (patient OTP / doctor tabs) |
| `03-signup.png` | Patient sign-up form |
| `04-home-chat.png` | Home chat with doctor cards and slot chips |
| `05-my-appointments.png` | My appointments: dark banner with stats, tabs, appointment cards, recent consultations, side cards |
| `06-payment.png` | Payment: order summary card + payment method cards |
| `07-mobile-chat.png` | Chat on a phone |
| `08-doctor-dashboard.png` | Doctor dashboard: sidebar, greeting + search, stat cards, schedule table, Now consulting, availability chips |
| `MediBook_UI_UX_Sample_Designs.pdf` | Original design mockups (patient home + chat, appointment history, doctor dashboard, mobile chat) |

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
