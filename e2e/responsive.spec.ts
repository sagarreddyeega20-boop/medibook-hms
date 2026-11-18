/**
 * Every screen is usable at 1280px (laptop) and 768px (tablet); the patient portal also at 375px (phone).
 * "Usable" here = the page never scrolls sideways (wide tables scroll inside their card) and the main heading
 * is on screen. Screenshots land in e2e/.artifacts/screens/<width>/ for a visual check.
 */
import { expect, test, type Page } from '@playwright/test';
import { login, loginPatient, type Who } from './helpers';

test.describe.configure({ mode: 'serial' });

const STAFF_WIDTHS = [1280, 768];
const PATIENT_WIDTHS = [1280, 768, 375];

async function check(page: Page, path: string, name: string, widths: number[]) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: width < 500 ? 812 : 900 });
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('h1').first()).toBeVisible();
    const overflow = await page.evaluate(() => {
      const doc = document.scrollingElement!;
      if (doc.scrollWidth <= doc.clientWidth + 1) return null;
      // Name the widest element that sticks out, to make a failure actionable.
      let worst = { tag: '', cls: '', right: 0 };
      for (const el of Array.from(document.body.querySelectorAll('*'))) {
        const r = el.getBoundingClientRect();
        if (r.right > worst.right) worst = { tag: el.tagName.toLowerCase(), cls: (el as HTMLElement).className?.toString().slice(0, 60), right: Math.round(r.right) };
      }
      return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, worst };
    });
    await page.screenshot({ path: `e2e/.artifacts/screens/${width}/${name}.png`, fullPage: true });
    expect(overflow, `${name} at ${width}px scrolls sideways`).toBeNull();
  }
}

const staffScreens: { who: Who; screens: [string, string | ((p: Page) => Promise<string>)][] }[] = [
  { who: 'admin', screens: [['admin-home', '/admin'], ['admin-staff', '/admin/staff'], ['admin-audit', '/admin/audit'], ['admin-departments', '/admin/departments'], ['admin-doctors', '/admin/doctors'], ['admin-prices', '/admin/prices']] },
  {
    who: 'reception',
    screens: [
      ['reception-board', '/reception'],
      ['reception-patients', '/reception/patients'],
      ['billing-counter', '/billing'],
      ['billing-patient', async (p) => `/billing/patients/${(await (await p.request.get('/api/billing/patients?q=Rahul')).json()).patients[0].id}`],
      ['billing-close-day', '/billing/close-day'],
    ],
  },
  {
    who: 'cardiologist',
    screens: [
      ['doctor-home', '/doctor'],
      ['doctor-consultation', async (p) => `/doctor/visits/${(await (await p.request.get('/api/visits/dashboard')).json()).rows.find((r: { visitId?: string }) => r.visitId).visitId}`],
      ['doctor-patient-record', async (p) => `/doctor/patients/${(await (await p.request.get('/api/visits/patients/search?q=Rahul')).json()).patients[0].id}`],
    ],
  },
  { who: 'lab', screens: [['lab-queue', '/lab']] },
  { who: 'radiology', screens: [['radiology-queue', '/radiology']] },
  {
    who: 'pharmacist',
    screens: [
      ['pharmacy-home', '/pharmacy'],
      ['pharmacy-dispense', async (p) => `/pharmacy/dispense/${(await (await p.request.get('/api/pharmacy/dashboard')).json()).queue[0].id}`],
      ['pharmacy-stock', '/pharmacy/stock'],
    ],
  },
  { who: 'accounts', screens: [['accounts-home', '/accounts']] },
];

for (const group of staffScreens) {
  test(`${group.who} screens at ${STAFF_WIDTHS.join(' / ')}px`, async ({ browser }) => {
    const page = await login(browser, group.who);
    for (const [name, path] of group.screens) await check(page, typeof path === 'string' ? path : await path(page), name, STAFF_WIDTHS);
    await page.context().close();
  });
}

test(`patient portal at ${PATIENT_WIDTHS.join(' / ')}px`, async ({ browser }) => {
  const page = await loginPatient(browser, { viewport: { width: 375, height: 812 } });
  for (const [name, path] of [['patient-home', '/patient'], ['patient-doctors', '/patient/doctors'], ['patient-appointments', '/patient/appointments'], ['patient-bills', '/patient/bills']] as const) {
    await check(page, path, name, PATIENT_WIDTHS);
  }
  await page.context().close();
});

test(`sign-in and sign-up at ${PATIENT_WIDTHS.join(' / ')}px`, async ({ page }) => {
  await check(page, '/login', 'login', PATIENT_WIDTHS);
  await check(page, '/register', 'register', PATIENT_WIDTHS);
});
