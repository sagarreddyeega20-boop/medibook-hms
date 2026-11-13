/**
 * Foundation seed (idempotent): roles, departments, a starter service catalogue,
 * settings, and the first Super Admin. Demo patients/doctors come in later steps.
 */
import { PrismaClient, type CatalogueCategory, type DepartmentKind, type RoleCode } from '@prisma/client';
import { hashSecret } from '../src/lib/password.js';

const prisma = new PrismaClient();

const roles: { code: RoleCode; name: string; description: string }[] = [
  { code: 'SUPER_ADMIN', name: 'Super Admin', description: 'Everything Admin can, plus creating Admins, integrations, backups' },
  { code: 'ADMIN', name: 'Admin', description: 'Staff, roles, departments, schedules, fees, audit log' },
  { code: 'RECEPTIONIST', name: 'Receptionist', description: "All doctors' slots and status, bookings, check-in, counter payments" },
  { code: 'DOCTOR', name: 'Doctor', description: 'Own schedule; timeline of treated patients; notes, prescriptions, orders, referrals' },
  { code: 'LAB_TECH', name: 'Lab technician', description: 'Lab order queue; upload results' },
  { code: 'RADIOLOGY_TECH', name: 'Radiology technician', description: 'Radiology order queue; upload results' },
  { code: 'PHARMACIST', name: 'Pharmacist', description: 'Prescriptions to dispense, stock' },
  { code: 'ACCOUNTS', name: 'Accounts', description: 'Revenue, transactions, counts by department, refunds' },
  { code: 'PATIENT', name: 'Patient', description: 'Own visits, reports, bills, family members' },
];

const departments: { code: string; name: string; kind: DepartmentKind }[] = [
  { code: 'GEN', name: 'General Medicine', kind: 'CLINICAL' },
  { code: 'CARD', name: 'Cardiology', kind: 'CLINICAL' },
  { code: 'NUTR', name: 'Nutrition', kind: 'CLINICAL' },
  { code: 'LAB', name: 'Laboratory', kind: 'LAB' },
  { code: 'RAD', name: 'Radiology', kind: 'RADIOLOGY' },
  { code: 'PHARM', name: 'Pharmacy', kind: 'PHARMACY' },
  { code: 'BILL', name: 'Billing & Accounts', kind: 'BILLING' },
  { code: 'ADMIN', name: 'Administration', kind: 'ADMIN' },
];

// Prices in integer paise.
const catalogue: { code: string; name: string; category: CatalogueCategory; dept: string; pricePaise: number }[] = [
  { code: 'CONS-GEN', name: 'Consultation – General Medicine', category: 'CONSULTATION', dept: 'GEN', pricePaise: 50000 },
  { code: 'CONS-CARD', name: 'Consultation – Cardiology', category: 'CONSULTATION', dept: 'CARD', pricePaise: 80000 },
  { code: 'CONS-NUTR', name: 'Consultation – Nutrition', category: 'CONSULTATION', dept: 'NUTR', pricePaise: 40000 },
  { code: 'LAB-ECG', name: 'ECG (12-lead)', category: 'LAB_TEST', dept: 'LAB', pricePaise: 30000 },
  { code: 'LAB-CBC', name: 'Complete Blood Count', category: 'LAB_TEST', dept: 'LAB', pricePaise: 35000 },
  { code: 'RAD-CXR', name: 'Chest X-ray (PA view)', category: 'RADIOLOGY_SCAN', dept: 'RAD', pricePaise: 60000 },
];

const settings = [
  { key: 'hospital.name', value: 'MediBook Hospital', description: 'Display name' },
  { key: 'hospital.timezone', value: 'Asia/Kolkata', description: 'Local timezone for schedules (DB stores UTC)' },
  { key: 'mrn.prefix', value: 'MB', description: 'Prefix for patient MRNs' },
  { key: 'pharmacy.lowStockDefault', value: 10, description: 'Default reorder level' },
];

async function main() {
  for (const r of roles) {
    await prisma.role.upsert({ where: { code: r.code }, update: { name: r.name, description: r.description }, create: r });
  }

  const deptIds: Record<string, string> = {};
  for (const d of departments) {
    const row = await prisma.department.upsert({ where: { code: d.code }, update: { name: d.name, kind: d.kind }, create: d });
    deptIds[d.code] = row.id;
  }

  for (const c of catalogue) {
    const data = { name: c.name, category: c.category, departmentId: deptIds[c.dept]!, pricePaise: c.pricePaise };
    await prisma.serviceCatalogue.upsert({ where: { code: c.code }, update: data, create: { code: c.code, ...data } });
  }

  for (const s of settings) {
    await prisma.setting.upsert({ where: { key: s.key }, update: {}, create: s });
  }

  const staffCode = process.env.SEED_SUPERADMIN_STAFF_ID ?? 'SA0001';
  const email = process.env.SEED_SUPERADMIN_EMAIL ?? 'superadmin@medibook.local';
  const password = process.env.SEED_SUPERADMIN_PASSWORD;
  if (!password) throw new Error('SEED_SUPERADMIN_PASSWORD is not set in .env');

  const existing = await prisma.staff.findUnique({ where: { staffCode } });
  if (!existing) {
    const superRole = await prisma.role.findUniqueOrThrow({ where: { code: 'SUPER_ADMIN' } });
    await prisma.user.create({
      data: {
        email,
        passwordHash: await hashSecret(password),
        roles: { create: { roleId: superRole.id } },
        staff: {
          create: { staffCode, fullName: 'Super Admin', designation: 'Super Administrator', departmentId: deptIds.ADMIN },
        },
      },
    });
  }

  console.log(`Seeded ${roles.length} roles, ${departments.length} departments, ${catalogue.length} catalogue items; Super Admin ${staffCode}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
