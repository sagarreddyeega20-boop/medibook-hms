/**
 * Seed (idempotent): roles + permissions, departments, a starter service catalogue, settings,
 * the Super Admin and one demo user per role. Re-running resets demo passwords and unlocks accounts.
 */
import { PrismaClient, type CatalogueCategory, type DepartmentKind, type RoleCode } from '@prisma/client';
import { hashPassword } from '../src/lib/password.js';
import { PERMISSIONS, ROLE_PERMISSIONS, type StaffRole } from '../src/modules/auth/permissions.js';
import { formatMrn } from '../src/modules/patients/patients.service.js';
import { nextStaffCode, ROLE_NAMES } from '../src/modules/staff/staff.service.js';
import { nextSequence } from '../src/lib/sequence.js';

const prisma = new PrismaClient();

const roles: { code: RoleCode; description: string }[] = [
  { code: 'SUPER_ADMIN', description: 'Everything Admin can, plus creating Admins, integrations, backups' },
  { code: 'ADMIN', description: 'Staff, roles, departments, schedules, fees, audit log' },
  { code: 'RECEPTIONIST', description: "All doctors' slots and status, bookings, check-in, counter payments" },
  { code: 'DOCTOR', description: 'Own schedule; timeline of treated patients; notes, prescriptions, orders, referrals' },
  { code: 'LAB_TECH', description: 'Lab order queue; upload results' },
  { code: 'RADIOLOGY_TECH', description: 'Radiology order queue; upload results' },
  { code: 'PHARMACIST', description: 'Prescriptions to dispense, stock' },
  { code: 'ACCOUNTS', description: 'Revenue, transactions, counts by department, refunds' },
  { code: 'PATIENT', description: 'Own visits, reports, bills, family members' },
];

const departments: { code: string; name: string; kind: DepartmentKind }[] = [
  { code: 'GEN', name: 'General Medicine', kind: 'CLINICAL' },
  { code: 'CARD', name: 'Cardiology', kind: 'CLINICAL' },
  { code: 'NUTR', name: 'Nutrition', kind: 'CLINICAL' },
  { code: 'DERM', name: 'Dermatology', kind: 'CLINICAL' },
  { code: 'ORTHO', name: 'Orthopaedics', kind: 'CLINICAL' },
  { code: 'LAB', name: 'Laboratory', kind: 'LAB' },
  { code: 'RAD', name: 'Radiology', kind: 'RADIOLOGY' },
  { code: 'PHARM', name: 'Pharmacy', kind: 'PHARMACY' },
  { code: 'BILL', name: 'Billing & Accounts', kind: 'BILLING' },
  { code: 'FRONT', name: 'Front Office', kind: 'ADMIN' },
  { code: 'ADMIN', name: 'Administration', kind: 'ADMIN' },
];

// Prices in integer paise.
const catalogue: { code: string; name: string; category: CatalogueCategory; dept: string; pricePaise: number }[] = [
  { code: 'CONS-GEN', name: 'Consultation – General Medicine', category: 'CONSULTATION', dept: 'GEN', pricePaise: 50000 },
  { code: 'CONS-CARD', name: 'Consultation – Cardiology', category: 'CONSULTATION', dept: 'CARD', pricePaise: 80000 },
  { code: 'CONS-NUTR', name: 'Consultation – Nutrition', category: 'CONSULTATION', dept: 'NUTR', pricePaise: 40000 },
  { code: 'CONS-DERM', name: 'Consultation – Dermatology', category: 'CONSULTATION', dept: 'DERM', pricePaise: 60000 },
  { code: 'CONS-ORTHO', name: 'Consultation – Orthopaedics', category: 'CONSULTATION', dept: 'ORTHO', pricePaise: 70000 },
  { code: 'LAB-ECG', name: 'ECG (12-lead)', category: 'LAB_TEST', dept: 'LAB', pricePaise: 30000 },
  { code: 'LAB-CBC', name: 'Complete Blood Count', category: 'LAB_TEST', dept: 'LAB', pricePaise: 35000 },
  { code: 'RAD-CXR', name: 'Chest X-ray (PA view)', category: 'RADIOLOGY_SCAN', dept: 'RAD', pricePaise: 60000 },
  { code: 'LAB-LIPID', name: 'Lipid profile', category: 'LAB_TEST', dept: 'LAB', pricePaise: 55000 },
  { code: 'LAB-HBA1C', name: 'HbA1c (glycated haemoglobin)', category: 'LAB_TEST', dept: 'LAB', pricePaise: 45000 },
  { code: 'LAB-TROP', name: 'Troponin I', category: 'LAB_TEST', dept: 'LAB', pricePaise: 90000 },
  { code: 'RAD-ECHO', name: '2D Echocardiogram', category: 'RADIOLOGY_SCAN', dept: 'RAD', pricePaise: 250000 },
  { code: 'RAD-USG-ABD', name: 'Ultrasound abdomen', category: 'RADIOLOGY_SCAN', dept: 'RAD', pricePaise: 120000 },
];

/** Starter pharmacy formulary (prices in paise; stock changes later go through stock_movements). */
const medicines = [
  { code: 'MED-ATOR10', name: 'Atorvastatin 10 mg', genericName: 'Atorvastatin', form: 'tablet', strength: '10 mg', purchasePricePaise: 450, sellingPricePaise: 800, stock: 500 },
  { code: 'MED-ASP75', name: 'Aspirin 75 mg', genericName: 'Acetylsalicylic acid', form: 'tablet', strength: '75 mg', purchasePricePaise: 150, sellingPricePaise: 300, stock: 800 },
  { code: 'MED-METO25', name: 'Metoprolol 25 mg', genericName: 'Metoprolol succinate', form: 'tablet', strength: '25 mg', purchasePricePaise: 350, sellingPricePaise: 650, stock: 400 },
  { code: 'MED-AMLO5', name: 'Amlodipine 5 mg', genericName: 'Amlodipine', form: 'tablet', strength: '5 mg', purchasePricePaise: 200, sellingPricePaise: 400, stock: 600 },
  { code: 'MED-METF500', name: 'Metformin 500 mg', genericName: 'Metformin', form: 'tablet', strength: '500 mg', purchasePricePaise: 120, sellingPricePaise: 250, stock: 900 },
  { code: 'MED-PCM650', name: 'Paracetamol 650 mg', genericName: 'Paracetamol', form: 'tablet', strength: '650 mg', purchasePricePaise: 100, sellingPricePaise: 200, stock: 1000 },
  { code: 'MED-CETZ10', name: 'Cetirizine 10 mg', genericName: 'Cetirizine', form: 'tablet', strength: '10 mg', purchasePricePaise: 80, sellingPricePaise: 180, stock: 700 },
  { code: 'MED-PANT40', name: 'Pantoprazole 40 mg', genericName: 'Pantoprazole', form: 'tablet', strength: '40 mg', purchasePricePaise: 300, sellingPricePaise: 600, stock: 500 },
];

const settings = [
  { key: 'hospital.name', value: 'MediBook Hospital', description: 'Display name' },
  { key: 'hospital.timezone', value: 'Asia/Kolkata', description: 'Local timezone for schedules (DB stores UTC)' },
  { key: 'mrn.prefix', value: 'MB', description: 'Prefix for patient MRNs' },
  { key: 'pharmacy.lowStockDefault', value: 10, description: 'Default reorder level' },
];

/** One demo account per staff role (emails are fake; OTPs print to the server console in development). */
const demoStaff: { role: StaffRole; name: string; email: string; dept: string }[] = [
  { role: 'ADMIN', name: 'Anita Rao', email: 'admin@medibook.local', dept: 'ADMIN' },
  { role: 'RECEPTIONIST', name: 'Kavya Menon', email: 'reception@medibook.local', dept: 'FRONT' },
  { role: 'DOCTOR', name: 'Dr. Ananya Iyer', email: 'doctor@medibook.local', dept: 'CARD' },
  { role: 'LAB_TECH', name: 'Ravi Kumar', email: 'lab@medibook.local', dept: 'LAB' },
  { role: 'RADIOLOGY_TECH', name: 'Meera Pillai', email: 'radiology@medibook.local', dept: 'RAD' },
  { role: 'PHARMACIST', name: 'Suresh Babu', email: 'pharmacy@medibook.local', dept: 'PHARM' },
  { role: 'ACCOUNTS', name: 'Farah Khan', email: 'accounts@medibook.local', dept: 'BILL' },
  { role: 'RECEPTIONIST', name: 'Joseph Thomas', email: 'reception2@medibook.local', dept: 'FRONT' },
  { role: 'DOCTOR', name: 'Dr. Vikram Nair', email: 'doctor.gen@medibook.local', dept: 'GEN' },
  { role: 'DOCTOR', name: 'Dr. Arjun Mehta', email: 'doctor.card@medibook.local', dept: 'CARD' },
  { role: 'DOCTOR', name: 'Dr. Sneha Kulkarni', email: 'doctor.nutrition@medibook.local', dept: 'NUTR' },
  { role: 'DOCTOR', name: 'Dr. Rhea Kapoor', email: 'doctor.derm@medibook.local', dept: 'DERM' },
  { role: 'DOCTOR', name: 'Dr. Karthik Rao', email: 'doctor.ortho@medibook.local', dept: 'ORTHO' },
];

/**
 * Doctor profiles and weekly schedules (hospital-local times). Created only when a doctor has no schedule yet,
 * so edits made in the admin console survive a re-seed. Days: 0 = Sun … 6 = Sat.
 */
const MON_SAT = [1, 2, 3, 4, 5, 6];
const doctorSetup: Record<string, { specialty: string; sessions: { days: number[]; start: string; end: string; slot: number }[] }> = {
  'doctor@medibook.local': { specialty: 'Interventional cardiology', sessions: [{ days: MON_SAT, start: '09:00', end: '13:00', slot: 15 }, { days: [1, 2, 3, 4, 5], start: '16:00', end: '20:00', slot: 15 }] },
  'doctor.gen@medibook.local': { specialty: 'Family medicine', sessions: [{ days: [0, ...MON_SAT], start: '08:00', end: '14:00', slot: 15 }, { days: [0, ...MON_SAT], start: '15:00', end: '21:00', slot: 15 }] },
  'doctor.card@medibook.local': { specialty: 'Heart failure & hypertension', sessions: [{ days: [1, 3, 5], start: '10:00', end: '17:00', slot: 20 }] },
  'doctor.nutrition@medibook.local': { specialty: 'Clinical nutrition & diabetes diet', sessions: [{ days: [1, 2, 4, 5, 6], start: '10:00', end: '18:00', slot: 30 }] },
  'doctor.derm@medibook.local': { specialty: 'Skin, hair & nails', sessions: [{ days: MON_SAT, start: '11:00', end: '19:00', slot: 15 }] },
  'doctor.ortho@medibook.local': { specialty: 'Joints, spine & sports injuries', sessions: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '15:00', slot: 20 }] },
};

const toMinute = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

/** Walk-in / booking demo patients (registered at reception). Rahul's mother is linked to his account. */
const demoPatients = [
  { fullName: 'Priya Sharma', gender: 'FEMALE' as const, dob: '1989-07-21', phone: '+91 98860 22334' },
  { fullName: 'Mohammed Ali', gender: 'MALE' as const, dob: '1975-01-05', phone: '+91 99000 45612' },
  { fullName: 'Lakshmi Narayanan', gender: 'FEMALE' as const, dob: '1958-11-30', phone: '+91 94480 77889' },
  { fullName: 'Sunita Sharma', gender: 'FEMALE' as const, dob: '1966-04-02', phone: '+91 98450 14410', familyOfDemo: 'Mother' },
];

const demoPatient = { fullName: 'Rahul Sharma', email: 'patient@medibook.local', phone: '+91 98450 14410', dob: '1994-03-12' };

function requirePassword(name: string, fallback?: string) {
  const pw = process.env[name] ?? fallback;
  if (!pw) throw new Error(`${name} is not set in .env`);
  if (pw.length < 10) throw new Error(`${name} must be at least 10 characters`);
  return pw;
}

async function upsertStaff(role: StaffRole, name: string, email: string, deptId: string, password: string) {
  const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
  const passwordHash = await hashPassword(password);
  const existing = await prisma.user.findUnique({ where: { email }, include: { staff: true } });

  if (existing?.staff) {
    let staffCode = existing.staff.staffCode;
    if (!/^HMS-[A-Z]{3}-\d{4}$/.test(staffCode)) staffCode = await nextStaffCode(role, prisma); // migrate old IDs (e.g. SA0001)
    await prisma.$transaction([
      prisma.user.update({ where: { id: existing.id }, data: { passwordHash, status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null } }),
      prisma.staff.update({ where: { id: existing.staff.id }, data: { staffCode, isActive: true, departmentId: deptId, fullName: name, designation: ROLE_NAMES[role] } }),
      prisma.userRole.deleteMany({ where: { userId: existing.id } }),
      prisma.userRole.create({ data: { userId: existing.id, roleId: roleRow.id } }),
    ]);
    return staffCode;
  }

  return prisma.$transaction(async (tx) => {
    const staffCode = await nextStaffCode(role, tx);
    await tx.user.create({
      data: {
        email, passwordHash,
        roles: { create: { roleId: roleRow.id } },
        staff: { create: { staffCode, fullName: name, designation: ROLE_NAMES[role], departmentId: deptId } },
      },
    });
    return staffCode;
  });
}

async function main() {
  // Roles, permissions and the role → permission mapping (from src/modules/auth/permissions.ts)
  for (const r of roles) {
    await prisma.role.upsert({ where: { code: r.code }, update: { name: ROLE_NAMES[r.code], description: r.description }, create: { ...r, name: ROLE_NAMES[r.code] } });
  }
  const permIds: Record<string, string> = {};
  for (const [code, description] of Object.entries(PERMISSIONS)) {
    permIds[code] = (await prisma.permission.upsert({ where: { code }, update: { description }, create: { code, description } })).id;
  }
  await prisma.permission.deleteMany({ where: { code: { notIn: Object.keys(PERMISSIONS) } } });
  for (const r of roles) {
    const role = await prisma.role.findUniqueOrThrow({ where: { code: r.code } });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({ data: ROLE_PERMISSIONS[r.code].map((p) => ({ roleId: role.id, permissionId: permIds[p]! })) });
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

  // Accounts
  const superEmail = (process.env.SEED_SUPERADMIN_EMAIL ?? 'superadmin@medibook.local').toLowerCase();
  const superPassword = requirePassword('SEED_SUPERADMIN_PASSWORD');
  const staffPassword = requirePassword('SEED_STAFF_PASSWORD', 'MediBook@2026');

  const printed: { role: string; login: string; email: string; password: string }[] = [];
  const superCode = await upsertStaff('SUPER_ADMIN', 'Super Admin', superEmail, deptIds.ADMIN!, superPassword);
  printed.push({ role: 'Super Admin', login: superCode, email: superEmail, password: '(SEED_SUPERADMIN_PASSWORD)' });
  for (const s of demoStaff) {
    const code = await upsertStaff(s.role, s.name, s.email, deptIds[s.dept]!, staffPassword);
    printed.push({ role: ROLE_NAMES[s.role], login: code, email: s.email, password: '(SEED_STAFF_PASSWORD)' });
  }

  // Formulary: created once with opening stock (a PURCHASE movement by the pharmacist); re-seeding never touches stock.
  const pharmacist = await prisma.staff.findFirstOrThrow({ where: { user: { email: 'pharmacy@medibook.local' } } });
  for (const m of medicines) {
    if (await prisma.medicine.findUnique({ where: { code: m.code } })) continue;
    await prisma.medicine.create({
      data: {
        code: m.code, name: m.name, genericName: m.genericName, form: m.form, strength: m.strength,
        purchasePricePaise: m.purchasePricePaise, sellingPricePaise: m.sellingPricePaise, stockQuantity: m.stock,
        stockMovements: { create: { type: 'PURCHASE', quantity: m.stock, unitCostPaise: m.purchasePricePaise, reference: 'Opening stock (seed)', performedById: pharmacist.id } },
      },
    });
  }

  // Demo patient (OTP-only, no password)
  let patient = await prisma.patient.findFirst({ where: { user: { email: demoPatient.email } } });
  if (!patient) {
    const patientRole = await prisma.role.findUniqueOrThrow({ where: { code: 'PATIENT' } });
    patient = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email: demoPatient.email, roles: { create: { roleId: patientRole.id } } } });
      const year = new Date().getUTCFullYear();
      return tx.patient.create({
        data: {
          mrn: formatMrn(year, await nextSequence(`mrn:${year}`, tx)),
          userId: user.id, firstName: 'Rahul', lastName: 'Sharma', gender: 'MALE',
          dateOfBirth: new Date(`${demoPatient.dob}T00:00:00Z`), email: demoPatient.email, phone: demoPatient.phone, registrationSource: 'ONLINE',
        },
      });
    });
  }
  printed.push({ role: 'Patient', login: `email OTP (${patient.mrn})`, email: demoPatient.email, password: '—' });

  // Doctor profiles + weekly schedules
  for (const [email, setup] of Object.entries(doctorSetup)) {
    const staff = await prisma.staff.findFirst({ where: { user: { email } } });
    if (!staff) continue;
    await prisma.staff.update({ where: { id: staff.id }, data: { specialty: staff.specialty ?? setup.specialty } });
    if ((await prisma.doctorSchedule.count({ where: { doctorId: staff.id } })) === 0) {
      await prisma.doctorSchedule.createMany({
        data: setup.sessions.flatMap((x) => x.days.map((dayOfWeek) => ({ doctorId: staff.id, dayOfWeek, startMinute: toMinute(x.start), endMinute: toMinute(x.end), slotMinutes: x.slot }))),
      });
    }
  }

  // Demo patients (MRNs from the same counter as real registrations)
  for (const p of demoPatients) {
    const [firstName, ...rest] = p.fullName.split(' ');
    let row = await prisma.patient.findFirst({ where: { firstName, lastName: rest.join(' '), phone: p.phone } });
    if (!row) {
      row = await prisma.$transaction(async (tx) => {
        const year = new Date().getUTCFullYear();
        return tx.patient.create({
          data: {
            mrn: formatMrn(year, await nextSequence(`mrn:${year}`, tx)), firstName: firstName!, lastName: rest.join(' '), gender: p.gender,
            dateOfBirth: new Date(`${p.dob}T00:00:00Z`), phone: p.phone, registrationSource: 'RECEPTION',
          },
        });
      });
    }
    if (p.familyOfDemo) {
      await prisma.familyMember.upsert({
        where: { accountPatientId_memberPatientId: { accountPatientId: patient.id, memberPatientId: row.id } },
        update: {},
        create: { accountPatientId: patient.id, memberPatientId: row.id, relationship: p.familyOfDemo },
      });
    }
  }

  console.log(`Seeded ${roles.length} roles, ${Object.keys(PERMISSIONS).length} permissions, ${departments.length} departments, ${catalogue.length} catalogue items, ${medicines.length} medicines.`);
  console.table(printed);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
