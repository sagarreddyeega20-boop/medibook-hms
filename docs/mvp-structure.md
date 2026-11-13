<!--
  Source: "MediBook HMS – MVP Structure.pdf" (Nov 12, 2026 · @venu).
  Transcribed from the PDF into Markdown; wording is unchanged. Tables and the
  data diagram were re-assembled from the PDF layout. The page-2 flow diagram
  was an image and only its caption is kept.
-->

# MediBook HMS - MVP Structure

Nov 12, 2026 · @venu

## Purpose and summary

The MediBook HMS MVP is the smallest version of a hospital-wide system that staff can use for real outpatient work from start to finish, designed so inpatient care and other departments can be added later without rebuilding.

It grows MediBook v1 (a doctor-patient booking app) into an organization-level platform: one patient record shared by every department, a live reception board, doctor dashboards that show every other doctor's notes and orders, lab, radiology and pharmacy queues, one bill per visit, and an accounts dashboard with revenue by department.

Access is controlled by hospital-issued staff IDs and roles, with email OTP verification.

This document also compares the MVP with the Hospital Appointment Platform - Structure v1.1 document received from a third party, which we use as a reference.

## End-to-end patient flow

*outpatient flow · arrival to accounts*

A patient enters through reception, the doctor's orders fan out to lab, radiology, other doctors and pharmacy, and everything lands on one visit record that drives a single bill and the accounts numbers.

## MVP scope

The MVP covers the complete outpatient journey; inpatient care is the first release after it.

| Area | In the MVP | Later |
|---|---|---|
| Access | Admin creates staff IDs, roles and departments; password + email OTP; audit log | Single sign-on, custom roles |
| Patients | One hospital patient ID (MRN); registration at reception or online; duplicate detection | ABHA/ABDM integration, document uploads |
| Reception | Live board of all doctors' slots and status; book, cancel, reschedule, walk-ins, check-in, queue tokens | Kiosks, SMS/WhatsApp reminders |
| Doctor | Own schedule, patient timeline, notes, prescriptions, test orders, referrals | Templates, voice notes, telemedicine |
| Lab and radiology | Order queues, mark sample or scan done, upload results to the timeline | Machine integration, image viewer (PACS) |
| Pharmacy | Receive prescriptions, dispense, basic stock with purchase price, low-stock alert | Suppliers, purchase orders, batch and expiry tracking |
| Billing | One bill per visit (consultation, tests, medicines); cash, UPI and card recorded at the counter | Insurance/TPA claims, online payment gateway |
| Accounts | Revenue by department, pharmacy margin, appointments vs walk-ins, total patients, transactions by date | Expense entry and full P&L, reporting database |
| Inpatient | -- | Admissions, bed board, rounds, nursing, discharge, running bill |
| Other modules | -- | Emergency, OT, blood bank, HR/payroll, ambulance, diet, housekeeping |

Roles in the MVP: Super Admin, Admin, Receptionist, Doctor, Lab technician, Radiology technician, Pharmacist, Accounts, Patient. Nurses arrive with inpatient care.

Technology: PostgreSQL (replacing v1's SQLite), Node.js + Express, Redis for slot holds, OTP limits and the live queue, WebSockets for live updates, and email OTP through Gmail SMTP or an email service.

## Ideas adopted from the reference document

These proven engineering patterns from the received structure document carry straight into the MVP:

- Redis for 10-minute slot holds, OTP rate limits and the live queue.
- Payments confirmed by gateway webhooks, never by trusting the browser.
- A separate background worker for reminders, hold expiry and reconciliation, outside web requests.
- Each module owns its tables; other modules go through its service.
- A request-path table documenting the API call, module and data behind every button.
- Audit logs, doctor leaves and family members on one patient account.
- Theme tokens, so pages never hard-code colours, fonts or spacing.
- Keys only in environment variables, and every route checks the user's role.

## Core design

### The visit is the centre of the data

Every contact with the hospital creates a visit (encounter): a booked appointment, a walk-in, and later an inpatient admission or emergency case. Notes, vitals, orders, prescriptions and charges all hang from the visit. This makes walk-ins work without fake appointments and lets inpatient care slot in later.

```
patient → appointment (optional) → visit ─┬→ notes, vitals
                                          ├→ orders → results
                                          ├→ prescriptions → dispensing
                                          └→ charges → invoice ← payments
```

### One order system for every department

A doctor creates an order with a type: lab test, radiology scan, referral to another doctor, or medication. Every order follows one lifecycle: ordered → scheduled → in progress → completed → result ready (or cancelled). Each department sees its own queue filtered by type, so a new service like physiotherapy is just a new order type, not a new module.

### A service catalogue drives the money

Every billable item (consultation by specialty, each test, each scan, later bed per day) lives in one price list, and each item belongs to a department. Completing an order or dispensing a medicine creates a charge with its department attached, so accounts gets revenue by department automatically. Pharmacy margin comes from purchase price vs selling price. Payments link to invoices through a payment allocation table, so one payment can cover several invoices and totals always reconcile.

| Table group | Main tables |
|---|---|
| People and access | users, roles, permissions, departments, staff, patients, family_members, consents |
| Scheduling | doctor_schedules, doctor_leaves, appointments, queue_events |
| Clinical | visits, clinical_notes, orders, order_results, referrals, prescriptions, prescription_items |
| Pharmacy | medicines, stock_movements, dispensations |
| Money | service_catalogue, charges, invoices, invoice_lines, payments, payment_allocations, refunds |
| System | otp_requests, notifications, audit_logs, access_overrides, settings |

## Access control and login

### Two layers of access

The role decides which screens a person gets. A second relationship layer decides which patients they can open: a doctor sees a patient's clinical record only if they have a visit, an order or a referral with that patient. In an emergency, a doctor can use break-glass access by typing a reason; access is granted, the admin is alerted, and the event is audited. Every view of clinical data is logged, not just changes.

| Role | Can see and do | Cannot see |
|---|---|---|
| Receptionist | All doctors' slots and status, patient contact details, bookings, check-in, counter payments | Clinical notes, diagnoses, results |
| Doctor | Own schedule; full timeline of patients they treat; notes, prescriptions, orders, referrals | Finances, unrelated patients (without break-glass) |
| Lab / Radiology technician | Their order queue with patient name and ID; upload results | Doctor notes, billing |
| Pharmacist | Prescriptions to dispense, stock | Doctor notes, editing prescriptions |
| Accounts | Revenue, transactions, counts by department, refunds | Diagnoses and clinical notes |
| Admin | Staff, roles, departments, schedules, fees, audit log | Clinical content by default |
| Super Admin | Everything Admin can, plus creating Admins, integrations, backups | -- |
| Patient | Own visits, reports, bills, family members | Everyone else's data |

### Login and OTP rules

| Who | Login |
|---|---|
| Patients | Email OTP (mobile OTP later) |
| All staff | Hospital-issued staff ID + password + email OTP at every login; no self sign-up |
| Admin | Same as staff; created only by a Super Admin |

OTP rules: 6 digits, 5-minute expiry, stored hashed, 5 wrong attempts then a 15-minute lock, 60-second resend cooldown, at most 5 OTPs per hour per account. Staff sessions time out after 15 minutes idle, and accounts lock after repeated wrong passwords.

## Reception live board

The central reception dashboard uses the same database as every other screen. A separate database would let a patient book a slot online while reception still saw it as free, causing double bookings. One database, with a rule that refuses two bookings for the same doctor and time, prevents this.

Each doctor's status is calculated, not typed: off duty or on leave (from schedule and leaves), available, in consultation (a visit is open), or running late (queue behind schedule). Changes reach every reception screen within a second through WebSockets. Reception can book, cancel, reschedule, register walk-ins and check patients in.

A separate reporting database (a read copy) comes later, for heavy accounts reports, so they never slow down live bookings.

## Additional hospital requirements

- Consent and data rights: record patient consent and handle data download requests, as required by India's DPDP Act 2023.
- Duplicate-patient detection at registration (same name, date of birth and phone).
- Safe payment retries: a repeated payment request never charges twice.
- Daily cash reconciliation for the billing counter.
- Automatic backups with a tested restore.
- Separate environments for development, testing and live use.

## MVP vs the received structure document

The received document is a strong appointment platform; our MVP is a hospital management system. It covers roughly 60% of our MVP: booking, queue, payments and billing are well designed, but the clinical journey between departments is missing.

| Topic | Received document (v1.1) | Our MVP |
|---|---|---|
| Centre of the data | The appointment | The visit; appointments, walk-ins and later admissions all create visits |
| Walk-ins | Unclear; visits hang from appointments | A visit without an appointment |
| Referrals between doctors | Not covered | Referral as an order type with a status lifecycle |
| Patient timeline | Visits exist; no rule on who sees other doctors' notes | Shared timeline for every treating doctor |
| Lab and radiology | Lab orders and results only | One order system covering lab, radiology, referrals, medication |
| Pharmacy | A role, but no stock or dispensing tables | Medicines, stock movements, dispensing, purchase price |
| Department revenue | Invoice lines have no department | Service catalogue tags every charge with a department |
| Payments across invoices | Stated, but no table to support it | Payment allocations table |
| OTP | SMS to mobile | Email OTP with expiry, attempt, cooldown and hourly limits |
| Staff 2FA | Only billing and admin | Every staff login |
| Patient-level access | Role only | Role + care relationship + break-glass, every view audited |
| Reception board | Queue tokens only | Live, calculated status for every doctor |
| Consent (DPDP) | Not covered | Consent records and data requests |
| Inpatient | Not covered | After the MVP; the visit model leaves room for it |
| Multi-branch, theme editor | Included | Left out of the MVP |
| SMS and WhatsApp alerts | Included | Email first; SMS and WhatsApp later |

Inconsistencies found in the received document: its data diagram places payments under invoices while its text says one payment covers several invoices; its rule that each module only reads its own tables conflicts with the Reports module reading everything; billing mentions insurance claims but there is no claims table; and the nurse station has no table for vitals.

## MVP done when

1. A receptionist registers a walk-in and books them with a cardiologist from the live board.
2. The cardiologist records notes, orders an ECG and refers the patient to a nutritionist.
3. The lab sees the ECG in its queue and uploads the result; it appears on the patient's timeline.
4. The nutritionist opens the patient and sees the cardiologist's notes, the referral reason and the ECG result.
5. The pharmacy dispenses the prescription and stock goes down.
6. The patient pays one bill covering consultation, test and medicines.
7. Accounts sees the revenue split across cardiology, lab, nutrition and pharmacy.
8. A receptionist trying to open clinical notes is refused, and an unrelated doctor can only get in through break-glass, which appears in the audit log.

## Roadmap after the MVP

| Release | Adds |
|---|---|
| 1. Inpatient | Admissions, bed board, wards, nurse role and vitals, rounds, discharge summary, running bill |
| 2. Money | Expense entry, full per-department P&L, insurance/TPA claims, online payment gateway, reporting database |
| 3. Reach | Patient portal improvements, SMS/WhatsApp, telemedicine, ABHA/ABDM integration |
| 4. Hospital-wide | Emergency, operation theatre, blood bank, HR and payroll, inventory and procurement |

## Open questions

- Do nurses need their own login before inpatient care arrives?
- Is the hospital a single site, or will branches be needed later?
- Which email service will send OTPs in production (Gmail SMTP for testing, a transactional email service for live use)?
