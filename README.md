# MediBook HMS

MVP hospital management system. Read [CLAUDE.md](CLAUDE.md) and [docs/mvp-structure.md](docs/mvp-structure.md) first.

```bash
cp .env.example .env        # then edit secrets
docker compose up -d        # PostgreSQL 16 + Redis 7
npm install
npm run db:migrate
npm run db:seed
npm run dev                 # API http://localhost:4000/api/health · web http://localhost:5173
```

Components demo: http://localhost:5173/demo/components · Tests: `npm test` (needs the docker services and `npm run db:seed`)

## Seeded logins

Open http://localhost:5173/login. **Staff** use the *Staff* tab: staff ID + password, then the 6-digit code emailed to them.
**Patients** use the *Patient* tab: email, then the code. In development every code is also printed in the server console:

```
[otp:dev] doctor@medibook.local → 482913 (expires in 5 min)
```

| Role | Staff ID / login | Email | Password | Home |
|---|---|---|---|---|
| Super Admin | `HMS-SUP-0001` | superadmin@medibook.local | value of `SEED_SUPERADMIN_PASSWORD` in `.env` | `/admin` |
| Admin | `HMS-ADM-0001` | admin@medibook.local | `MediBook@2026` | `/admin` |
| Receptionist | `HMS-REC-0001` | reception@medibook.local | `MediBook@2026` | `/reception` |
| Doctor | `HMS-DOC-0001` | doctor@medibook.local | `MediBook@2026` | `/doctor` |
| Lab technician | `HMS-LAB-0001` | lab@medibook.local | `MediBook@2026` | `/lab` |
| Radiology technician | `HMS-RAD-0001` | radiology@medibook.local | `MediBook@2026` | `/radiology` |
| Pharmacist | `HMS-PHA-0001` | pharmacy@medibook.local | `MediBook@2026` | `/pharmacy` |
| Accounts | `HMS-ACC-0001` | accounts@medibook.local | `MediBook@2026` | `/accounts` |
| Patient | email OTP (MRN `MB-2026-000001`) | patient@medibook.local | — (no password) | `/patient` |

The staff password comes from `SEED_STAFF_PASSWORD` (default `MediBook@2026`). Re-running `npm run db:seed` resets the
demo passwords and unlocks the accounts. Seeded emails are fake (`.local`), so use the console code for them.

## Identity & access (module `auth`, `staff`, `notifications`, `audit`)

- **Roles → permissions**: `server/src/modules/auth/permissions.ts` is the single source (seeded into `roles`,
  `permissions`, `role_permissions`). Routes guard with `requireAuth`, `requireRole(...)`, `requirePermission(...)`.
- **Staff** have no self sign-up. *Staff & roles* (`/admin/staff`) creates staff with an auto staff ID
  `HMS-<ROLE>-NNNN` and emails a set-password link (valid 24 h). Only a Super Admin can create or change Admins.
  Staff are deactivated, never deleted. Role changes end the person's open sessions.
- **Patients** register at `/register` (name, gender, date of birth, email, phone). The account and the MRN
  (`MB-YYYY-NNNNNN`) are created only after the email code is verified.
- **OTP rules** (Redis): 6 digits, stored hashed, 5-minute expiry, 5 wrong attempts → 15-minute lock,
  60-second resend cooldown, at most 5 codes per hour per account. Errors are generic and never say whether an account exists.
- **Passwords**: bcrypt cost 12, at least 10 characters; 5 wrong passwords lock the account for 15 minutes.
- **Sessions**: random ID in an httpOnly, Secure, SameSite=Strict cookie (`mb_sid`); data in Redis.
  Idle timeout 15 min for staff, 30 min for patients; 12 h absolute limit.
- **Email**: every message goes through `notificationsService.notify(recipient, template, data)` (EMAIL today; SMS/WhatsApp
  later). To send real email, set Gmail SMTP in `.env` (see `.env.example`): `SMTP_HOST=smtp.gmail.com`, your Gmail
  address as `SMTP_USER`, and a Google **App Password** as `SMTP_PASS`.
- **Audit** (`/admin/audit`): logins, failed logins, account and OTP locks, password set, staff creation, role changes,
  deactivations, patient registration and 403 access denials.
