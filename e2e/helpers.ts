import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Browser, type Locator, type Page } from '@playwright/test';

/** Seeded staff (prisma/seed.ts). Password = SEED_STAFF_PASSWORD (default MediBook@2026). */
export const PASSWORD = process.env.SEED_STAFF_PASSWORD ?? 'MediBook@2026';
export const STAFF = {
  reception: { staffId: 'HMS-REC-0001', email: 'reception@medibook.local', name: 'Kavya Menon' },
  cardiologist: { staffId: 'HMS-DOC-0001', email: 'doctor@medibook.local', name: 'Dr. Ananya Iyer' },
  lab: { staffId: 'HMS-LAB-0001', email: 'lab@medibook.local', name: 'Ravi Kumar' },
  nutritionist: { staffId: 'HMS-DOC-0004', email: 'doctor.nutrition@medibook.local', name: 'Dr. Sneha Kulkarni' },
  pharmacist: { staffId: 'HMS-PHA-0001', email: 'pharmacy@medibook.local', name: 'Suresh Babu' },
  accounts: { staffId: 'HMS-ACC-0001', email: 'accounts@medibook.local', name: 'Farah Khan' },
  orthopaedician: { staffId: 'HMS-DOC-0005', email: 'doctor.ortho@medibook.local', name: 'Dr. Karthik Rao' },
  admin: { staffId: 'HMS-ADM-0001', email: 'admin@medibook.local', name: 'Anita Rao' },
  radiology: { staffId: 'HMS-RAD-0001', email: 'radiology@medibook.local', name: 'Meera Pillai' },
} as const;
export const PATIENT = { email: 'patient@medibook.local', name: 'Rahul Sharma' };
export type Who = keyof typeof STAFF;

const LOG = join(__dirname, '.artifacts', 'server.log');
const logSize = () => {
  try {
    return statSync(LOG).size;
  } catch {
    return 0;
  }
};

/** Waits for the next development OTP printed for `email` after byte offset `from` of the API log. */
async function otpFor(email: string, from: number): Promise<string> {
  const re = new RegExp(`\\[otp:dev\\] ${email.replace(/[.]/g, '\\.')} → (\\d{6})`, 'g');
  for (let i = 0; i < 100; i++) {
    const text = readFileSync(LOG).subarray(from).toString('utf8');
    const all = [...text.matchAll(re)];
    if (all.length) return all[all.length - 1]![1]!;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`No OTP for ${email} in ${LOG}`);
}

/** Staff login through the UI: Staff ID + password → emailed code → home. One browser context per person. */
export async function login(browser: Browser, who: Who): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const s = STAFF[who];
  await page.goto('/login');
  await page.getByLabel('Staff ID').fill(s.staffId);
  await page.getByLabel('Password').fill(PASSWORD);
  const mark = logSize();
  await page.getByRole('button', { name: 'Continue' }).click();
  const code = await otpFor(s.email, mark);
  await page.locator('input.mb-otp').fill(code);
  await page.getByRole('button', { name: /Verify/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  return page;
}

/** Patient login through the UI: email → emailed code → portal. */
export async function loginPatient(browser: Browser, opts: { viewport?: { width: number; height: number } } = {}): Promise<Page> {
  const ctx = await browser.newContext(opts.viewport ? { viewport: opts.viewport } : {});
  const page = await ctx.newPage();
  await page.goto('/login?tab=patient');
  await page.getByLabel('Email').fill(PATIENT.email);
  const mark = logSize();
  await page.getByRole('button', { name: 'Send OTP' }).click();
  const code = await otpFor(PATIENT.email, mark);
  await page.locator('input.mb-otp').fill(code);
  await page.getByRole('button', { name: /Verify/ }).click();
  await page.waitForURL(/\/patient/);
  return page;
}

/** Picks the <option> whose text contains `text` in a native <select> found by its label. */
export async function selectByText(scope: Page | Locator, label: string | RegExp, text: string) {
  const select = scope.getByLabel(label, { exact: typeof label === 'string' });
  const option = select.locator('option', { hasText: text }).first();
  await expect(option).toBeAttached();
  await select.selectOption((await option.getAttribute('value'))!);
}

/** A table row (or list item) containing `text`. */
export const rowWith = (page: Page | Locator, text: string) => page.locator('tr, li').filter({ hasText: text }).first();
