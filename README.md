# MediBook HMS

MVP hospital management system for outpatient care: one patient record shared by every department, a live reception
board, doctor consultations with notes, orders, referrals and prescriptions, lab / radiology / pharmacy queues, one bill
per visit, counter payments and an accounts dashboard with revenue by department.

Scope and rules: [docs/mvp-structure.md](docs/mvp-structure.md) (the spec) and [CLAUDE.md](CLAUDE.md) (how the code is organised).

## Requirements

- **Node.js 20 or newer** (`.nvmrc`) and npm
- **Docker** (Docker Desktop on Windows/macOS) for PostgreSQL 16 and Redis 7

Nothing else: the PostgreSQL tools used by the backup scripts run inside the database container.

## Setup (fresh clone)

```bash
cp .env.example .env
```

```bash
docker compose up -d
```

```bash
npm install
```

```bash
npm run db:migrate
```

```bash
npm run db:seed
```

```bash
npm run dev
```

Open **http://localhost:5173/login**. The API is at http://localhost:4000 (health: http://localhost:4000/api/health).

- `.env.example` works as-is for local use. Change `JWT_SECRET` (and the seed passwords) for anything shared.
- Postgres runs on host port **5434** and Redis on **6380**, so they don't clash with other local projects.
- `db:seed` takes about 1–2 minutes the first time: it generates a month of demo activity (see below).
- On Windows, if `npm install` fails with `EPERM … query_engine-windows.dll.node`, another running copy of the app is
  holding the Prisma engine. Stop it and run `npm install` again.

## Commands

| Command | What it does |
|---|---|
| `docker compose up -d` | Starts PostgreSQL (port 5434) and Redis (port 6380) |
| `docker compose down` | Stops them (data is kept in Docker volumes) |
| `npm install` | Installs every workspace (server, web) and generates the Prisma client |
| `npm run dev` | API on :4000 + web app on :5173, both reloading on change |
| `npm run build` | Type-checks and builds the server (`server/dist`) and the web app (`web/dist`) |
| `npm run db:migrate` | Applies database migrations (`prisma migrate dev`) |
| `npm run db:seed` | Seeds roles, departments, prices, staff, doctors, patients, medicines — and, on an empty database, a month of demo activity. Safe to re-run: resets demo passwords and unlocks accounts |
| `npm run db:reset` | **Drops all data**, re-applies migrations and seeds again — use it to get demo data dated from today |
| `npm run db:backup` | Backs up the database with `pg_dump` (+ uploaded result files) to `backups/<timestamp>/` |
| `npm run db:restore` | Restores the newest backup (or `npm run db:restore -- backups/<dir>`); asks you to type `restore` (`-- --yes` skips the prompt). Stop `npm run dev` first |
| `npm test` | Server tests (Vitest: API, security, backup→restore) + web type-check. Needs Docker running and a seeded database |
| `npm run test:e2e` | Playwright end-to-end test of the "MVP done when" list and the responsive checks (see below) |
| `npm run db:studio -w server` | Prisma Studio, a browser view of the tables |

Before the first `npm run test:e2e`, install the browser once:

```bash
npx playwright install chromium
```

## Seeded logins

**Staff** sign in on the *Staff* tab with staff ID + password, then a 6-digit code sent by email.
**Patients** use the *Patient* tab with their email, then the code.
Seeded emails are fake (`.local`), so in development **every code is printed in the `npm run dev` console**:

```
[otp:dev] doctor@medibook.local → 482913 (expires in 5 min)
```

Every staff password is `MediBook@2026` (`SEED_STAFF_PASSWORD`). The Super Admin's is `SEED_SUPERADMIN_PASSWORD` (`ChangeMe!2026` in `.env.example`).

| Role | Staff ID | Name | Email | Home |
|---|---|---|---|---|
| Super Admin | `HMS-SUP-0001` | Super Admin | superadmin@medibook.local | `/admin` |
| Admin | `HMS-ADM-0001` | Anita Rao | admin@medibook.local | `/admin` |
| Receptionist | `HMS-REC-0001` | Kavya Menon | reception@medibook.local | `/reception` |
| Receptionist | `HMS-REC-0002` | Joseph Thomas | reception2@medibook.local | `/reception` |
| Lab technician | `HMS-LAB-0001` | Ravi Kumar | lab@medibook.local | `/lab` |
| Radiology technician | `HMS-RAD-0001` | Meera Pillai | radiology@medibook.local | `/radiology` |
| Pharmacist | `HMS-PHA-0001` | Suresh Babu | pharmacy@medibook.local | `/pharmacy` |
| Accounts | `HMS-ACC-0001` | Farah Khan | accounts@medibook.local | `/accounts` |
| Patient | email OTP · MRN `MB-2026-000001` | Rahul Sharma (+ mother Sunita on his account) | patient@medibook.local | `/patient` |

**Doctors** (all `/doctor`):

| Staff ID | Doctor | Department | Email | Weekly hours (IST) |
|---|---|---|---|---|
| `HMS-DOC-0001` | Dr. Ananya Iyer | Cardiology | doctor@medibook.local | Mon–Sat 09:00–13:00, Mon–Fri 16:00–20:00 |
| `HMS-DOC-0003` | Dr. Arjun Mehta | Cardiology | doctor.card@medibook.local | Mon, Wed, Fri 10:00–17:00 |
| `HMS-DOC-0006` | Dr. Rohan Desai | Cardiology | doctor.card2@medibook.local | Tue, Thu, Sat 10:00–16:00 |
| `HMS-DOC-0002` | Dr. Vikram Nair | General Medicine | doctor.gen@medibook.local | Daily 08:00–14:00, 15:00–21:00 |
| `HMS-DOC-0007` | Dr. Fatima Sheikh | General Medicine | doctor.gen2@medibook.local | Mon–Sat 09:00–15:00 |
| `HMS-DOC-0008` | Dr. Harish Gowda | General Medicine | doctor.gen3@medibook.local | Mon–Sat 14:00–20:00 (on leave today and tomorrow) |
| `HMS-DOC-0004` | Dr. Sneha Kulkarni | Nutrition | doctor.nutrition@medibook.local | Mon–Sat 10:00–18:00 |
| `HMS-DOC-0009` | Dr. Pooja Hegde | Nutrition | doctor.nutrition2@medibook.local | Mon, Wed, Fri 14:00–19:00 |
| `HMS-DOC-0005` | Dr. Karthik Rao | Orthopaedics | doctor.ortho@medibook.local | Mon–Fri 09:00–15:00 |
| `HMS-DOC-0010` | Dr. Nikhil Joshi | Orthopaedics | doctor.ortho2@medibook.local | Tue, Thu, Sat 11:00–18:00 (leave next week) |

### What the demo data contains

Generated by `server/prisma/demo-data.ts`, dated relative to the day you seed:

- Departments: Cardiology, Nutrition, General Medicine, Orthopaedics, Laboratory, Radiology, Pharmacy (plus the
  non-clinical Front Office, Billing & Accounts and Administration that staff belong to).
- 10 doctors with weekly schedules and leaves, 40 patients (some registered in the last month).
- About 30 days of outpatient activity: ~640 visits (booked appointments and walk-ins), consultation notes and vitals,
  ~800 lab and radiology results, cardiology → nutrition referrals, ~600 prescriptions dispensed with stock movements,
  one bill per visit, cash/UPI/card payments, a refund waiting for accounts and a rejected one, and every past day
  closed at the counter (one day ₹200 short).
- **Today:** completed visits, patients waiting and in consultation, later slots booked, lab/radiology orders in the
  queues, prescriptions waiting at the pharmacy, unpaid bills at the counter, two referrals for reception to book,
  and a low-stock medicine. The next 7 days have bookings.
- Rahul Sharma (the portal patient) has a cardiology visit with ECG and lipid results, a nutrition follow-up from the
  referral, an unpaid bill, his mother's visit and an upcoming appointment.

The data is generated only on a database without visits. To refresh the dates, run `npm run db:reset`.

## Demo walkthrough: the cardiology journey

This follows the eight "MVP done when" steps. Each person needs their own session, so use a **separate browser
profile or private window per role** (one sign-in per browser). Keep the `npm run dev` console visible for the codes.

1. **Reception registers a walk-in** — sign in as `HMS-REC-0001`. The live board shows every doctor's calculated status.
   Click **New walk-in** → **Register new patient** (e.g. *Arun Kumar*, Male, 1972-05-14, +91 98450 33221) →
   **Register patient** → Doctor: *Dr. Ananya Iyer · Cardiology* → complaint *Chest tightness on stairs* → **Issue token**.
   The token appears; no appointment was created — a walk-in is a visit without one.
2. **The cardiologist consults** — sign in as `HMS-DOC-0001`. Arun is in today's list → **Start consult**.
   - *Notes*: complaint, findings, diagnosis *Stable angina*, advice → **Save notes**.
   - *Lab & radiology*: choose *ECG (12-lead)* → **Place order**.
   - *Referral*: Department *Nutrition*, Doctor *Dr. Sneha Kulkarni*, reason *Low-salt, low-fat diet for angina* → **Send referral**.
   - *Prescription*: *Atorvastatin 10 mg*, 1 tablet, `0-0-1`, 10 days → **Save prescription**.
   - **Complete visit**. The consultation charge (Cardiology) lands on the visit's bill.
3. **The lab uploads the ECG** — sign in as `HMS-LAB-0001`. Arun's ECG is in the queue (name, MRN, test, doctor,
   urgency — no clinical notes). **Sample collected** → **Upload result** → findings *Sinus rhythm, no ST changes* →
   **Upload result**. Dr. Iyer gets a "Result ready" alert; the result is on Arun's timeline.
4. **The nutritionist sees the full picture** — sign in as `HMS-DOC-0004`. Under **Referrals to you**, open Arun's
   **Timeline**: the cardiologist's notes, the referral reason and the ECG result. To bill the nutrition consult, reception
   sends Arun in (New walk-in → search *Arun* → *Dr. Sneha Kulkarni*); the nutritionist **Start consult** sees
   "Referred by Dr. Ananya Iyer", saves notes and **Complete visit**.
5. **Pharmacy dispenses** — sign in as `HMS-PHA-0001`. Arun's prescription is in the queue → **Dispense** →
   **Dispense in full**. Atorvastatin stock drops by 10 (*Stock* page); the medicine is charged to the bill.
6. **Arun pays one bill** — as reception, open **Billing counter**, search *Arun* → his account. The cardiology bill has
   the consultation, the ECG and the medicine (**View**). Tick the bills, choose **Cash** → **Record ₹… by Cash** →
   print the receipt.
7. **Accounts sees the split** — sign in as `HMS-ACC-0001`. *Revenue by department* shows Cardiology, Laboratory,
   Nutrition and Pharmacy (choose *Today* to see just today), with pharmacy margin, payments by method and the CSV export.
8. **Access control** — as reception, try `http://localhost:5173/doctor/patients/<Arun's id>` (or the notes API): refused.
   Sign in as an unrelated doctor, `HMS-DOC-0005` (orthopaedics), search *Arun* → **Open record**: "No access to this
   record". Type an emergency reason → **Break glass & open record**: 60 minutes of read access, the admin is alerted.
   Sign in as `HMS-ADM-0001` → **Audit log**: the BREAK_GLASS entry with the reason, every view made under it, and the
   receptionist's ACCESS_DENIED.

The same journey runs automatically in `npm run test:e2e` (`e2e/mvp-done.spec.ts`).

## Tests

- **`npm test`** — 120+ server tests against the docker-compose database: auth and OTP rules, role-based access,
  booking (no double booking), clinical access and break-glass, queues, pharmacy stock and margin, billing and refunds,
  plus:
  - `src/security.test.ts` lists **every API route** and fails if one is not behind `requireAuth` + a role/permission
    check (only the sign-in routes are public, and they must be rate limited), if a protected route doesn't answer 401
    without a session, or if a route skips Zod validation of its params/body. It also checks helmet headers, CORS,
    rate limiting, that nothing is served statically and that no secrets are committed.
  - `src/backup.test.ts` runs `db:backup`, restores it into a scratch database and compares row counts.
- **`npm run test:e2e`** — Playwright starts its own API (:4400) and web app (:5180) on the same database, so it can
  run beside `npm run dev`. It reads sign-in codes from that API's log (`e2e/.artifacts/server.log`).
  - `e2e/mvp-done.spec.ts`: the 8 "MVP done when" steps through the UI as the seeded staff (a new patient each run).
  - `e2e/responsive.spec.ts`: every staff screen at 1280 px and 768 px, the patient portal and sign-in at 1280, 768 and
    375 px, with no sideways scrolling. Screenshots go to `e2e/.artifacts/screens/`.

## Security

- **Access** = role (screens and API permissions, `server/src/modules/auth/permissions.ts`) + care relationship
  (a doctor opens a patient only with a visit, order or referral) + break-glass (reason, admin alerted, audited).
  Every view of clinical data writes an `audit_logs` row; refusals are audited too.
- **Sign-in**: staff ID + password + email OTP; patients email OTP. OTPs are hashed, expire in 5 minutes, lock after
  5 wrong tries, 60 s resend cooldown, 5 per hour. Passwords are bcrypt; 5 wrong passwords lock the account.
- **Rate limits** (Redis, per client IP, 15-minute window, tunable in `.env`): 30 sign-in/OTP requests per IP and 10 per
  IP + account; 60 OTP verifications per IP. Over the limit → 429 with `Retry-After`.
- **Sessions**: random ID in an httpOnly, Secure, SameSite=Strict cookie; staff idle timeout 15 min.
- **HTTP**: helmet security headers; CORS allows only `CORS_ORIGIN` (exact origins, never `*`); 1 MB body limit
  (8 MB for result uploads); every params/query/body parsed with Zod; errors never include stack traces.
- **Uploads** (result PDFs/images) are stored outside any static folder and served only by
  `GET /api/orders/results/:id/file` to the lab/radiology queue, treating clinicians and the patient's household.
- **Secrets** come only from `.env` (git-ignored), validated in `server/src/config/env.ts`. In production the server
  refuses to start with the example `JWT_SECRET`.

## Backups

```bash
npm run db:backup
```

writes `backups/<timestamp>/` with `medibook.dump` (pg_dump custom format), the uploaded result files and a
`manifest.json` of row counts. Restore with

```bash
npm run db:restore
```

(newest backup) or `npm run db:restore -- backups/<timestamp>`. The restore drops and recreates the database, puts the
files back and checks the row counts match the manifest. `-- --target-db <name>` restores into another database to
inspect a backup without touching the live one. Copy `backups/` somewhere off the machine; schedule `npm run db:backup`
with cron / Task Scheduler for daily backups.

## Known limitations

- **No inpatient care**: admissions, beds, wards, nurses, rounds and discharge come in the next release
  (`Visit.type` already reserves `IPD` and `EMERGENCY`). There is no nurse login.
- **No SMS or WhatsApp**: OTPs, booking confirmations and alerts go by email only. Without SMTP settings, emails are
  printed in the server console.
- **Counter payments only**: cash, UPI and card are recorded at the billing counter. There is no online payment gateway
  and no insurance/TPA claims; patients see and download bills in the portal but pay at the hospital.
- Refunds are approved in the app but paid out manually (cash / UPI / card reversal outside the system).
- Backups are run on demand (`npm run db:backup`); scheduling them and copying them off-site is up to the operator.
- Single hospital site, a single API instance (Socket.IO and rate limits assume one server), no reporting replica.
- Pharmacy stock has no suppliers, purchase orders, batches or expiry dates; lab/radiology have no machine or PACS integration.
- Patients cannot upload documents; consent records exist in the schema but there is no consent / data-request screen yet.
- Demo data is dated from the day it was seeded; run `npm run db:reset` to move it to today.

## Project layout

```
server/   Express + Prisma API (modules: auth, staff, patients, scheduling, reception, visits, orders, pharmacy,
          billing, accounts, audit, notifications); prisma/schema.prisma, migrations, seed.ts + demo-data.ts
web/      React + Vite app; src/components (v1 design components), src/pages (one folder per role), /demo pages
e2e/      Playwright specs (MVP journey, responsive checks)
scripts/  db-backup.mjs, db-restore.mjs
docs/     the MVP spec and v1 UI reference screenshots
```

### Identity & access details

- **Staff** have no self sign-up. *Staff & roles* (`/admin/staff`) creates staff with an auto staff ID
  `HMS-<ROLE>-NNNN` and emails a set-password link (valid 24 h). Only a Super Admin can create or change Admins.
  Staff are deactivated, never deleted. Role changes end the person's open sessions.
- **Patients** register at `/register`. The account and the MRN (`MB-YYYY-NNNNNN`) are created only after the email
  code is verified.
- **Email**: every message goes through `notificationsService.notify(recipient, template, data)`. To send real email,
  set Gmail SMTP in `.env` (see `.env.example`): `SMTP_HOST=smtp.gmail.com`, your Gmail address as `SMTP_USER`, and a
  Google **App Password** as `SMTP_PASS`.
