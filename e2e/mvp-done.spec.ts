/**
 * docs/mvp-structure.md — "MVP done when", all 8 steps, through the web app as the seeded staff.
 * One new walk-in patient per run (unique name), so the suite can be re-run on the same database.
 */
import { expect, test, type Page } from '@playwright/test';
import { login, rowWith, selectByText, STAFF } from './helpers';

test.describe.configure({ mode: 'serial' });

const stamp = Date.now().toString().slice(-6);
const patientName = `Arun Test${stamp}`;
const phone = `+91 98${stamp.slice(0, 3)} ${stamp.slice(3)}11`;
const diagnosis = `Stable angina (e2e ${stamp})`;
const referralReason = `Low-salt, low-fat diet plan for angina and weight (e2e ${stamp})`;
const ecgFindings = `Sinus rhythm 76/min, no ST changes (e2e ${stamp})`;
const breakGlassReason = `Collapsed in the orthopaedic OPD, need cardiac history (e2e ${stamp})`;

let patientId = '';
let atorvaStockBefore = 0;
const pages: Partial<Record<keyof typeof STAFF, Page>> = {};
const as = async (who: keyof typeof STAFF, browser: import('@playwright/test').Browser) => (pages[who] ??= await login(browser, who));

test.afterAll(async () => {
  for (const p of Object.values(pages)) await p?.context().close();
});

test('1. A receptionist registers a walk-in and books them with a cardiologist from the live board', async ({ browser }) => {
  const page = await as('reception', browser);
  await expect(page).toHaveURL(/\/reception$/);
  await expect(page.getByRole('heading', { name: /Doctors/ })).toBeVisible();

  await page.getByRole('button', { name: 'New walk-in' }).click();
  const modal = page.getByRole('dialog');
  await modal.getByRole('button', { name: 'Register new patient' }).click();
  await modal.getByLabel('Full name').fill(patientName);
  await selectByText(modal, 'Gender', 'Male');
  await modal.getByLabel('Date of birth').fill('1972-05-14');
  await modal.getByLabel('Mobile').fill(phone);
  await modal.getByRole('button', { name: 'Register patient' }).click();
  await expect(modal.getByText(patientName)).toBeVisible();

  await selectByText(modal, 'Doctor', STAFF.cardiologist.name);
  await modal.getByLabel('Complaint (optional)').fill('Chest tightness on climbing stairs');
  const walkIn = page.waitForResponse((r) => r.url().endsWith('/api/reception/walk-ins') && r.request().method() === 'POST');
  await modal.getByRole('button', { name: 'Issue token' }).click();
  const body = await (await walkIn).json();
  expect(body.visit.type).toBe('WALK_IN');
  expect(body.visit.appointmentId).toBeNull(); // a walk-in is a visit without an appointment
  patientId = body.patient.id;
  await expect(modal.getByText('Walk-in registered')).toBeVisible();
  await expect(modal.getByText(`is in the queue for ${STAFF.cardiologist.name}`)).toBeVisible();
  await modal.getByRole('button', { name: 'Done' }).click();
});

test('2. The cardiologist records notes, orders an ECG, prescribes, and refers the patient to a nutritionist', async ({ browser }) => {
  const page = await as('cardiologist', browser);
  await expect(page).toHaveURL(/\/doctor$/);
  await rowWith(page, patientName).getByRole('button', { name: 'Start consult' }).click();
  await expect(page).toHaveURL(/\/doctor\/visits\//);
  await expect(page.getByRole('heading', { name: patientName })).toBeVisible();

  // Notes
  await page.getByLabel('Complaint').fill('Chest tightness on climbing two flights of stairs for 3 weeks');
  await page.getByLabel('Findings').fill('BP 146/92, pulse 84 regular. Heart sounds normal.');
  await page.getByLabel('Diagnosis').fill(diagnosis);
  await page.getByLabel('Advice').fill('Avoid heavy exertion until reviewed. Walk 20 minutes daily.');
  await page.getByRole('button', { name: 'Save notes' }).click();
  await expect(page.getByText(/Last saved/)).toBeVisible();

  // ECG
  await page.getByRole('tab', { name: /Lab & radiology/ }).click();
  await selectByText(page, 'Test or scan (service catalogue)', 'ECG');
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page.getByRole('table', { name: 'Orders on this visit' }).getByText('ECG (12-lead)')).toBeVisible();

  // Referral to the nutritionist
  await page.getByRole('tab', { name: /Referral/ }).click();
  await selectByText(page, 'Department', 'Nutrition');
  await selectByText(page, 'Doctor (optional)', STAFF.nutritionist.name);
  await page.getByLabel('Reason for referral').fill(referralReason);
  await page.getByRole('button', { name: 'Send referral' }).click();
  await expect(page.getByRole('table', { name: 'Orders on this visit' }).getByText(/Referral to/)).toBeVisible();

  // Prescription
  await page.getByRole('tab', { name: /Prescription/ }).click();
  await page.getByLabel('Medicine', { exact: true }).fill('Atorvastatin 10 mg');
  await page.getByLabel('Dose').fill('1 tablet');
  await page.getByLabel('Frequency').fill('0-0-1');
  await page.getByLabel('Days').fill('10');
  await page.getByRole('button', { name: 'Save prescription' }).click();
  await expect(page.getByRole('table', { name: 'Orders on this visit' }).getByText('Atorvastatin 10 mg')).toBeVisible();

  // Close the consultation → consultation charge on the visit's bill
  await page.getByRole('button', { name: 'Complete visit' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Complete visit' }).click();
  await expect(page.getByText(/Read only/)).toBeVisible();
});

test('3. The lab sees the ECG in its queue and uploads the result; it appears on the patient’s timeline', async ({ browser }) => {
  const page = await as('lab', browser);
  await expect(page).toHaveURL(/\/lab$/);
  const row = rowWith(page, patientName);
  await expect(row).toContainText('ECG (12-lead)');
  await row.getByRole('button', { name: 'Sample collected' }).click();
  await rowWith(page, patientName).getByRole('button', { name: 'Upload result' }).click();
  await page.getByLabel('Findings').fill(ecgFindings);
  await page.getByRole('button', { name: 'Upload result' }).last().click();
  await expect(rowWith(page, patientName)).toContainText(/Result ready/i);

  // On the timeline (the ordering cardiologist's view)
  const doc = pages.cardiologist!;
  await doc.goto(`/doctor/patients/${patientId}`);
  await expect(doc.getByText(ecgFindings)).toBeVisible();
});

test('4. The nutritionist opens the patient and sees the cardiologist’s notes, the referral reason and the ECG result', async ({ browser }) => {
  const page = await as('nutritionist', browser);
  await expect(page).toHaveURL(/\/doctor$/);
  const referrals = page.locator('.mb-card').filter({ has: page.getByRole('heading', { name: 'Referrals to you' }) });
  await rowWith(referrals, patientName).getByRole('button', { name: 'Timeline' }).click();
  await expect(page).toHaveURL(new RegExp(`/doctor/patients/${patientId}`));
  await expect(page.getByText(diagnosis).first()).toBeVisible();
  await expect(page.getByText(referralReason).first()).toBeVisible();
  await expect(page.getByText(ecgFindings).first()).toBeVisible();

  // The patient is then seen in Nutrition (reception sends them in; the visit answers the referral).
  const desk = pages.reception!;
  await desk.goto('/reception');
  await desk.getByRole('button', { name: 'New walk-in' }).click();
  const modal = desk.getByRole('dialog');
  await modal.getByLabel('Patient').fill(patientName);
  await modal.getByRole('list', { name: 'Matching patients' }).getByRole('button', { name: new RegExp(patientName) }).click();
  await selectByText(modal, 'Doctor', STAFF.nutritionist.name);
  await modal.getByRole('button', { name: 'Issue token' }).click();
  await expect(modal.getByText('Walk-in registered')).toBeVisible();
  await modal.getByRole('button', { name: 'Done' }).click();

  await page.goto('/doctor');
  await rowWith(page, patientName).getByRole('button', { name: 'Start consult' }).click();
  await expect(page.getByText(`Referred by ${STAFF.cardiologist.name}`)).toBeVisible();
  await expect(page.getByText(referralReason).first()).toBeVisible();
  await page.getByLabel('Diagnosis').fill('Dyslipidaemia — dietary management');
  await page.getByLabel('Advice').fill('1500 kcal DASH diet, salt under 5 g a day. Review in 4 weeks.');
  await page.getByRole('button', { name: 'Save notes' }).click();
  await expect(page.getByText(/Last saved/)).toBeVisible();
  await page.getByRole('button', { name: 'Complete visit' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Complete visit' }).click();
  await expect(page.getByText(/Read only/)).toBeVisible();
});

test('5. The pharmacy dispenses the prescription and stock goes down', async ({ browser }) => {
  const page = await as('pharmacist', browser);
  await expect(page).toHaveURL(/\/pharmacy$/);
  const stock = async () => {
    const r = await page.request.get('/api/pharmacy/medicines?q=Atorvastatin');
    const m = (await r.json()).medicines.find((x: { name: string }) => x.name === 'Atorvastatin 10 mg');
    return m.stockQuantity as number;
  };
  atorvaStockBefore = await stock();
  await rowWith(page, patientName).getByRole('button', { name: 'Dispense' }).click();
  await expect(page.getByRole('heading', { name: 'Dispense prescription' })).toBeVisible();
  await expect(page.getByText(diagnosis)).toHaveCount(0); // no doctor notes for the pharmacist
  await page.getByRole('button', { name: 'Dispense in full' }).click();
  await expect(page).toHaveURL(/\/pharmacy$/);
  expect(await stock()).toBe(atorvaStockBefore - 10); // 0-0-1 × 10 days
});

test('6. The patient pays one bill covering consultation, test and medicines', async ({ browser }) => {
  const page = await as('reception', browser);
  await page.goto(`/billing`);
  await page.getByPlaceholder('Search patient ID, name or phone').fill(patientName);
  await rowWith(page, patientName).click();
  await expect(page).toHaveURL(new RegExp(`/billing/patients/${patientId}`));

  // The cardiology visit's single bill carries the consultation, the ECG and the medicine.
  const account = await (await page.request.get(`/api/billing/patients/${patientId}`)).json();
  const invoices = account.invoices as { id: string; invoiceNumber: string; visit: { department: string } }[];
  const cardio = invoices.find((i) => i.visit.department === 'Cardiology')!;
  const inv = (await (await page.request.get(`/api/billing/invoices/${cardio.id}`)).json()).invoice;
  const lineDepts = inv.lines.map((l: { department: { name: string } | string }) => (typeof l.department === 'string' ? l.department : l.department.name)).sort();
  expect(lineDepts).toEqual(['Cardiology', 'Laboratory', 'Pharmacy']);

  for (const i of invoices) await page.getByRole('checkbox', { name: `Pay ${i.invoiceNumber}` }).check();
  await page.getByText('Cash', { exact: true }).click();
  await page.getByRole('button', { name: /^Record ₹.* by Cash$/ }).click();
  await expect(page.getByRole('dialog').getByText('Payment recorded')).toBeVisible();

  const after = await (await page.request.get(`/api/billing/patients/${patientId}`)).json();
  expect(after.outstandingPaise).toBe(0);
  expect(after.invoices.every((i: { status: string }) => i.status === 'PAID')).toBe(true);
});

test('7. Accounts sees the revenue split across cardiology, lab, nutrition and pharmacy', async ({ browser }) => {
  const page = await as('accounts', browser);
  await expect(page).toHaveURL(/\/accounts$/);
  const table = page.getByRole('table', { name: 'Revenue by department' });
  for (const dept of ['Cardiology', 'Laboratory', 'Nutrition', 'Pharmacy']) await expect(table.getByText(dept, { exact: true })).toBeVisible();

  // Today's figures include this patient's charges, each counted for its own department.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const d = await (await page.request.get(`/api/accounts/dashboard?from=${today}&to=${today}`)).json();
  const byName = Object.fromEntries(d.revenueByDepartment.map((r: { name: string; revenuePaise: number }) => [r.name, r.revenuePaise]));
  expect(byName.Cardiology).toBeGreaterThanOrEqual(80000);
  expect(byName.Laboratory).toBeGreaterThanOrEqual(30000);
  expect(byName.Nutrition).toBeGreaterThanOrEqual(40000);
  expect(byName.Pharmacy).toBeGreaterThanOrEqual(8000);
  expect(d.transactions.some((t: { patient: { id: string } | null }) => t.patient?.id === patientId)).toBe(true);
});

test('8. A receptionist is refused clinical notes; an unrelated doctor gets in only through break-glass, which is audited', async ({ browser }) => {
  // Receptionist: the API refuses, and the doctor screens are not reachable.
  const desk = pages.reception ?? (await as('reception', browser));
  const notes = await desk.request.get(`/api/visits/patients/${patientId}/notes`);
  expect(notes.status()).toBe(403);
  await desk.goto(`/doctor/patients/${patientId}`);
  await expect(desk).toHaveURL(/\/reception$/);

  // Unrelated doctor (orthopaedics): refused, then break-glass with a reason.
  const ortho = await as('orthopaedician', browser);
  expect((await ortho.request.get(`/api/visits/patients/${patientId}/timeline`)).status()).toBe(403);
  await ortho.goto(`/doctor/patients/${patientId}`);
  await expect(ortho.getByText('No access to this record')).toBeVisible();
  await expect(ortho.getByText(diagnosis)).toHaveCount(0);
  await ortho.getByLabel('Emergency reason').fill(breakGlassReason);
  await ortho.getByRole('button', { name: /Break glass/ }).click();
  await expect(ortho.getByText(diagnosis).first()).toBeVisible();

  // Admin: the break-glass is in the audit log with its reason; the receptionist's refusal too.
  const admin = await as('admin', browser);
  await admin.goto('/admin/audit');
  // The break-glass row (the views made under it repeat the reason in later rows).
  await expect(admin.getByRole('table', { name: 'Audit events' }).getByRole('cell', { name: `“${breakGlassReason}” · 60 min` })).toBeVisible();
  const audit = await (await admin.request.get(`/api/audit?action=BREAK_GLASS&patientId=${patientId}`)).json();
  expect(audit.entries[0]).toMatchObject({ action: 'BREAK_GLASS', reason: breakGlassReason, actor: { name: STAFF.orthopaedician.name } });
  const denied = await (await admin.request.get('/api/audit?action=ACCESS_DENIED&limit=50')).json();
  expect(denied.entries.some((e: { actor: { name: string } | null; entityId: string }) => e.actor?.name === STAFF.reception.name && e.entityId.includes(patientId))).toBe(true);
});
