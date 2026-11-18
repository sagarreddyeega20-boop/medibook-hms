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
import { seedDemoData, type DemoCtx } from './demo-data.js';

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
  { code: 'CONS-ORTHO', name: 'Consultation – Orthopaedics', category: 'CONSULTATION', dept: 'ORTHO', pricePaise: 70000 },
  { code: 'LAB-ECG', name: 'ECG (12-lead)', category: 'LAB_TEST', dept: 'LAB', pricePaise: 30000 },
  { code: 'LAB-CBC', name: 'Complete Blood Count', category: 'LAB_TEST', dept: 'LAB', pricePaise: 35000 },
  { code: 'RAD-CXR', name: 'Chest X-ray (PA view)', category: 'RADIOLOGY_SCAN', dept: 'RAD', pricePaise: 60000 },
  { code: 'LAB-LIPID', name: 'Lipid profile', category: 'LAB_TEST', dept: 'LAB', pricePaise: 55000 },
  { code: 'LAB-HBA1C', name: 'HbA1c (glycated haemoglobin)', category: 'LAB_TEST', dept: 'LAB', pricePaise: 45000 },
  { code: 'LAB-TROP', name: 'Troponin I', category: 'LAB_TEST', dept: 'LAB', pricePaise: 90000 },
  { code: 'RAD-ECHO', name: '2D Echocardiogram', category: 'RADIOLOGY_SCAN', dept: 'RAD', pricePaise: 250000 },
  { code: 'RAD-USG-ABD', name: 'Ultrasound abdomen', category: 'RADIOLOGY_SCAN', dept: 'RAD', pricePaise: 120000 },
  { code: 'LAB-FBS', name: 'Fasting blood sugar', category: 'LAB_TEST', dept: 'LAB', pricePaise: 12000 },
  { code: 'LAB-TSH', name: 'Thyroid stimulating hormone (TSH)', category: 'LAB_TEST', dept: 'LAB', pricePaise: 40000 },
  { code: 'LAB-VITD', name: '25-OH Vitamin D', category: 'LAB_TEST', dept: 'LAB', pricePaise: 120000 },
  { code: 'RAD-XR-KNEE', name: 'X-ray knee (AP and lateral)', category: 'RADIOLOGY_SCAN', dept: 'RAD', pricePaise: 50000 },
  { code: 'RAD-XR-LSS', name: 'X-ray lumbosacral spine', category: 'RADIOLOGY_SCAN', dept: 'RAD', pricePaise: 65000 },
  { code: 'RAD-MRI-KNEE', name: 'MRI knee', category: 'RADIOLOGY_SCAN', dept: 'RAD', pricePaise: 650000 },
];

/** Starter pharmacy formulary (prices in paise; stock changes later go through stock_movements). */
const medicines: { code: string; name: string; genericName: string; form: string; strength: string; purchasePricePaise: number; sellingPricePaise: number; stock: number; reorderLevel?: number }[] = [
  { code: 'MED-ATOR10', name: 'Atorvastatin 10 mg', genericName: 'Atorvastatin', form: 'tablet', strength: '10 mg', purchasePricePaise: 450, sellingPricePaise: 800, stock: 3000 },
  { code: 'MED-ASP75', name: 'Aspirin 75 mg', genericName: 'Acetylsalicylic acid', form: 'tablet', strength: '75 mg', purchasePricePaise: 150, sellingPricePaise: 300, stock: 3000 },
  { code: 'MED-METO25', name: 'Metoprolol 25 mg', genericName: 'Metoprolol succinate', form: 'tablet', strength: '25 mg', purchasePricePaise: 350, sellingPricePaise: 650, stock: 2500 },
  { code: 'MED-AMLO5', name: 'Amlodipine 5 mg', genericName: 'Amlodipine', form: 'tablet', strength: '5 mg', purchasePricePaise: 200, sellingPricePaise: 400, stock: 2500 },
  { code: 'MED-METF500', name: 'Metformin 500 mg', genericName: 'Metformin', form: 'tablet', strength: '500 mg', purchasePricePaise: 120, sellingPricePaise: 250, stock: 4000 },
  { code: 'MED-PCM650', name: 'Paracetamol 650 mg', genericName: 'Paracetamol', form: 'tablet', strength: '650 mg', purchasePricePaise: 100, sellingPricePaise: 200, stock: 3000 },
  { code: 'MED-CETZ10', name: 'Cetirizine 10 mg', genericName: 'Cetirizine', form: 'tablet', strength: '10 mg', purchasePricePaise: 80, sellingPricePaise: 180, stock: 1500 },
  { code: 'MED-PANT40', name: 'Pantoprazole 40 mg', genericName: 'Pantoprazole', form: 'tablet', strength: '40 mg', purchasePricePaise: 300, sellingPricePaise: 600, stock: 2000 },
  { code: 'MED-TELM40', name: 'Telmisartan 40 mg', genericName: 'Telmisartan', form: 'tablet', strength: '40 mg', purchasePricePaise: 300, sellingPricePaise: 550, stock: 2500 },
  { code: 'MED-CLOP75', name: 'Clopidogrel 75 mg', genericName: 'Clopidogrel', form: 'tablet', strength: '75 mg', purchasePricePaise: 400, sellingPricePaise: 750, stock: 2000 },
  { code: 'MED-GLIM1', name: 'Glimepiride 1 mg', genericName: 'Glimepiride', form: 'tablet', strength: '1 mg', purchasePricePaise: 150, sellingPricePaise: 300, stock: 2000 },
  { code: 'MED-THYR50', name: 'Levothyroxine 50 mcg', genericName: 'Levothyroxine', form: 'tablet', strength: '50 mcg', purchasePricePaise: 120, sellingPricePaise: 220, stock: 2000 },
  { code: 'MED-AZI500', name: 'Azithromycin 500 mg', genericName: 'Azithromycin', form: 'tablet', strength: '500 mg', purchasePricePaise: 1800, sellingPricePaise: 3200, stock: 600 },
  { code: 'MED-DICL50', name: 'Diclofenac 50 mg', genericName: 'Diclofenac sodium', form: 'tablet', strength: '50 mg', purchasePricePaise: 100, sellingPricePaise: 220, stock: 2000 },
  { code: 'MED-IBU400', name: 'Ibuprofen 400 mg', genericName: 'Ibuprofen', form: 'tablet', strength: '400 mg', purchasePricePaise: 90, sellingPricePaise: 180, stock: 2000 },
  { code: 'MED-CALD3', name: 'Calcium 500 mg + Vitamin D3', genericName: 'Calcium carbonate + cholecalciferol', form: 'tablet', strength: '500 mg', purchasePricePaise: 250, sellingPricePaise: 450, stock: 2500 },
  { code: 'MED-VITD60K', name: 'Cholecalciferol 60,000 IU', genericName: 'Vitamin D3', form: 'sachet', strength: '60000 IU', purchasePricePaise: 2500, sellingPricePaise: 4500, stock: 400 },
  // Rarely prescribed and nearly out: shows the low-stock alert on the pharmacy dashboard.
  { code: 'MED-INSG100', name: 'Insulin glargine 100 IU/mL pen', genericName: 'Insulin glargine', form: 'injection', strength: '100 IU/mL', purchasePricePaise: 45000, sellingPricePaise: 62000, stock: 6, reorderLevel: 10 },
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
  { role: 'DOCTOR', name: 'Dr. Karthik Rao', email: 'doctor.ortho@medibook.local', dept: 'ORTHO' },
  { role: 'DOCTOR', name: 'Dr. Rohan Desai', email: 'doctor.card2@medibook.local', dept: 'CARD' },
  { role: 'DOCTOR', name: 'Dr. Fatima Sheikh', email: 'doctor.gen2@medibook.local', dept: 'GEN' },
  { role: 'DOCTOR', name: 'Dr. Harish Gowda', email: 'doctor.gen3@medibook.local', dept: 'GEN' },
  { role: 'DOCTOR', name: 'Dr. Pooja Hegde', email: 'doctor.nutrition2@medibook.local', dept: 'NUTR' },
  { role: 'DOCTOR', name: 'Dr. Nikhil Joshi', email: 'doctor.ortho2@medibook.local', dept: 'ORTHO' },
];

/**
 * Doctor profiles and weekly schedules (hospital-local times). Created only when a doctor has no schedule yet,
 * so edits made in the admin console survive a re-seed. Days: 0 = Sun … 6 = Sat.
 */
const MON_SAT = [1, 2, 3, 4, 5, 6];
const doctorSetup: Record<string, { specialty: string; sessions: { days: number[]; start: string; end: string; slot: number }[] }> = {
  'doctor@medibook.local': { specialty: 'Interventional cardiology', sessions: [{ days: MON_SAT, start: '09:00', end: '13:00', slot: 15 }, { days: [1, 2, 3, 4, 5], start: '16:00', end: '20:00', slot: 15 }] },
  'doctor.card@medibook.local': { specialty: 'Heart failure & hypertension', sessions: [{ days: [1, 3, 5], start: '10:00', end: '17:00', slot: 20 }] },
  'doctor.card2@medibook.local': { specialty: 'Electrophysiology & arrhythmia', sessions: [{ days: [2, 4, 6], start: '10:00', end: '16:00', slot: 20 }] },
  'doctor.gen@medibook.local': { specialty: 'Family medicine', sessions: [{ days: [0, ...MON_SAT], start: '08:00', end: '14:00', slot: 15 }, { days: [0, ...MON_SAT], start: '15:00', end: '21:00', slot: 15 }] },
  'doctor.gen2@medibook.local': { specialty: 'Internal medicine & diabetes', sessions: [{ days: MON_SAT, start: '09:00', end: '15:00', slot: 15 }] },
  'doctor.gen3@medibook.local': { specialty: 'Fevers & infectious diseases', sessions: [{ days: MON_SAT, start: '14:00', end: '20:00', slot: 15 }] },
  'doctor.nutrition@medibook.local': { specialty: 'Clinical nutrition & diabetes diet', sessions: [{ days: MON_SAT, start: '10:00', end: '18:00', slot: 30 }] },
  'doctor.nutrition2@medibook.local': { specialty: 'Sports & weight-management nutrition', sessions: [{ days: [1, 3, 5], start: '14:00', end: '19:00', slot: 30 }] },
  'doctor.ortho@medibook.local': { specialty: 'Joints, spine & sports injuries', sessions: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '15:00', slot: 20 }] },
  'doctor.ortho2@medibook.local': { specialty: 'Spine & sports medicine', sessions: [{ days: [2, 4, 6], start: '11:00', end: '18:00', slot: 20 }] },
};

const toMinute = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

/**
 * Demo patients (registered at reception). `focus` = the department they mostly visit; `since` = days since
 * registration (recent ones count as new patients on the accounts dashboard). Sunita is Rahul's mother.
 */
type DemoPatient = { fullName: string; gender: 'MALE' | 'FEMALE'; dob: string; phone: string; focus: string; since: number; email?: string; familyOfDemo?: string };
const demoPatients: DemoPatient[] = [
  { fullName: 'Priya Sharma', gender: 'FEMALE', dob: '1989-07-21', phone: '+91 98860 22334', focus: 'GEN', since: 120 },
  { fullName: 'Mohammed Ali', gender: 'MALE', dob: '1975-01-05', phone: '+91 99000 45612', focus: 'CARD', since: 200 },
  { fullName: 'Lakshmi Narayanan', gender: 'FEMALE', dob: '1958-11-30', phone: '+91 94480 77889', focus: 'CARD', since: 300 },
  { fullName: 'Sunita Sharma', gender: 'FEMALE', dob: '1966-04-02', phone: '+91 98450 14410', focus: 'GEN', since: 90, familyOfDemo: 'Mother' },
  { fullName: 'Ramesh Gupta', gender: 'MALE', dob: '1962-08-14', phone: '+91 98451 20871', focus: 'CARD', since: 260 },
  { fullName: 'Anjali Deshpande', gender: 'FEMALE', dob: '1991-02-09', phone: '+91 99860 33121', focus: 'NUTR', since: 75 },
  { fullName: 'Suresh Reddy', gender: 'MALE', dob: '1970-12-25', phone: '+91 90080 55432', focus: 'GEN', since: 180, email: 'suresh.reddy@example.com' },
  { fullName: 'Kavitha Krishnan', gender: 'FEMALE', dob: '1984-06-17', phone: '+91 97400 81234', focus: 'ORTHO', since: 140 },
  { fullName: 'Arvind Patel', gender: 'MALE', dob: '1955-03-28', phone: '+91 98800 44567', focus: 'CARD', since: 365 },
  { fullName: 'Deepa Nair', gender: 'FEMALE', dob: '1979-09-03', phone: '+91 96320 17788', focus: 'NUTR', since: 60 },
  { fullName: 'Imran Khan', gender: 'MALE', dob: '1987-05-11', phone: '+91 99459 62310', focus: 'ORTHO', since: 95 },
  { fullName: 'Meenakshi Sundaram', gender: 'FEMALE', dob: '1949-10-19', phone: '+91 94430 26754', focus: 'CARD', since: 400 },
  { fullName: 'Vijay Kumar', gender: 'MALE', dob: '1968-07-07', phone: '+91 98861 73902', focus: 'GEN', since: 220 },
  { fullName: 'Shalini Joshi', gender: 'FEMALE', dob: '1995-01-23', phone: '+91 90199 48236', focus: 'GEN', since: 45, email: 'shalini.joshi@example.com' },
  { fullName: 'Abdul Rahman', gender: 'MALE', dob: '1959-04-15', phone: '+91 98455 90321', focus: 'CARD', since: 160 },
  { fullName: 'Pooja Iyer', gender: 'FEMALE', dob: '1993-11-02', phone: '+91 99010 27765', focus: 'NUTR', since: 50 },
  { fullName: 'Ganesh Hegde', gender: 'MALE', dob: '1973-02-18', phone: '+91 94481 36620', focus: 'ORTHO', since: 130 },
  { fullName: 'Fathima Beevi', gender: 'FEMALE', dob: '1964-08-30', phone: '+91 97391 58844', focus: 'GEN', since: 240 },
  { fullName: 'Sanjay Malhotra', gender: 'MALE', dob: '1980-12-12', phone: '+91 98804 11902', focus: 'CARD', since: 110 },
  { fullName: 'Nandini Rao', gender: 'FEMALE', dob: '1988-03-06', phone: '+91 99726 40018', focus: 'GEN', since: 70 },
  { fullName: 'Thomas Mathew', gender: 'MALE', dob: '1957-06-24', phone: '+91 94470 82239', focus: 'CARD', since: 330 },
  { fullName: 'Harpreet Kaur', gender: 'FEMALE', dob: '1977-10-10', phone: '+91 98150 63371', focus: 'NUTR', since: 85 },
  { fullName: 'Prakash Shetty', gender: 'MALE', dob: '1966-01-31', phone: '+91 98440 75583', focus: 'ORTHO', since: 210 },
  { fullName: 'Revathi Subramanian', gender: 'FEMALE', dob: '1982-04-27', phone: '+91 96860 19947', focus: 'GEN', since: 150 },
  { fullName: 'Karan Singh', gender: 'MALE', dob: '1998-09-15', phone: '+91 99800 52276', focus: 'ORTHO', since: 25 },
  { fullName: 'Asha Kulkarni', gender: 'FEMALE', dob: '1960-02-11', phone: '+91 94484 30065', focus: 'CARD', since: 280 },
  { fullName: 'Rajesh Pillai', gender: 'MALE', dob: '1971-07-29', phone: '+91 98472 66104', focus: 'GEN', since: 22 },
  { fullName: 'Divya Menon', gender: 'FEMALE', dob: '1990-05-19', phone: '+91 97456 21183', focus: 'NUTR', since: 20, email: 'divya.menon@example.com' },
  { fullName: 'Manoj Tiwari', gender: 'MALE', dob: '1965-11-08', phone: '+91 99350 74412', focus: 'CARD', since: 18 },
  { fullName: 'Sarita Yadav', gender: 'FEMALE', dob: '1985-08-22', phone: '+91 98390 15560', focus: 'GEN', since: 16 },
  { fullName: 'Naveen Chandra', gender: 'MALE', dob: '1992-03-14', phone: '+91 90360 88217', focus: 'ORTHO', since: 14 },
  { fullName: 'Geeta Bhat', gender: 'FEMALE', dob: '1953-12-01', phone: '+91 94490 61329', focus: 'CARD', since: 12 },
  { fullName: 'Rohit Agarwal', gender: 'MALE', dob: '1983-06-05', phone: '+91 98300 47751', focus: 'NUTR', since: 10 },
  { fullName: 'Zainab Hussain', gender: 'FEMALE', dob: '1996-10-26', phone: '+91 99020 36648', focus: 'GEN', since: 8 },
  { fullName: 'Venkatesh Murthy', gender: 'MALE', dob: '1958-05-09', phone: '+91 98453 92075', focus: 'CARD', since: 6 },
  { fullName: 'Leela Fernandes', gender: 'FEMALE', dob: '1974-01-17', phone: '+91 98221 50394', focus: 'ORTHO', since: 4 },
  { fullName: 'Aditya Rao', gender: 'MALE', dob: '2001-08-03', phone: '+91 90080 63118', focus: 'ORTHO', since: 3 },
  { fullName: 'Shobha Raghavan', gender: 'FEMALE', dob: '1961-03-21', phone: '+91 94473 28856', focus: 'GEN', since: 2 },
  { fullName: 'Kiran Desai', gender: 'MALE', dob: '1978-09-09', phone: '+91 98197 04462', focus: 'NUTR', since: 1 },
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
    // Consultations, tests and scans are GST-exempt: tax 0 on create; re-seeding never overrides a rate the admin changed.
    await prisma.serviceCatalogue.upsert({ where: { code: c.code }, update: data, create: { code: c.code, ...data, taxPercent: 0 } });
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
  const openingStockAt = new Date(Date.now() - 35 * 86_400_000);
  for (const m of medicines) {
    if (await prisma.medicine.findUnique({ where: { code: m.code } })) continue;
    await prisma.medicine.create({
      data: {
        code: m.code, name: m.name, genericName: m.genericName, form: m.form, strength: m.strength, reorderLevel: m.reorderLevel ?? 50,
        purchasePricePaise: m.purchasePricePaise, sellingPricePaise: m.sellingPricePaise, stockQuantity: m.stock, createdAt: openingStockAt,
        stockMovements: { create: { type: 'PURCHASE', quantity: m.stock, unitCostPaise: m.purchasePricePaise, reference: 'Opening stock (seed)', performedById: pharmacist.id, createdAt: openingStockAt } },
      },
    });
  }
  // Every medicine is billed through its own catalogue item in Pharmacy (5% GST), as the dispense flow does.
  for (const m of await prisma.medicine.findMany({ select: { id: true, code: true, name: true, sellingPricePaise: true, catalogueItemId: true } })) {
    const item = await prisma.serviceCatalogue.upsert({
      where: { code: `MED-ITEM-${m.code}` },
      update: {},
      create: { code: `MED-ITEM-${m.code}`, name: m.name, category: 'MEDICINE', departmentId: deptIds.PHARM!, pricePaise: m.sellingPricePaise, taxPercent: 5 },
    });
    if (m.catalogueItemId !== item.id) await prisma.medicine.update({ where: { id: m.id }, data: { catalogueItemId: item.id } });
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
          userId: user.id, firstName: 'Rahul', lastName: 'Sharma', gender: 'MALE', createdAt: new Date(Date.now() - 180 * 86_400_000),
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
  const receptionist = await prisma.staff.findFirstOrThrow({ where: { user: { email: 'reception@medibook.local' } } });
  const patientRows: { id: string; createdAt: Date; focus: string }[] = [{ id: patient.id, createdAt: patient.createdAt, focus: 'CARD' }];
  let motherId = '';
  for (const p of demoPatients) {
    const [firstName, ...rest] = p.fullName.split(' ');
    let row = await prisma.patient.findFirst({ where: { firstName, lastName: rest.join(' '), phone: p.phone } });
    if (!row) {
      row = await prisma.$transaction(async (tx) => {
        const year = new Date().getUTCFullYear();
        return tx.patient.create({
          data: {
            mrn: formatMrn(year, await nextSequence(`mrn:${year}`, tx)), firstName: firstName!, lastName: rest.join(' '), gender: p.gender,
            dateOfBirth: new Date(`${p.dob}T00:00:00Z`), phone: p.phone, email: p.email ?? null, registrationSource: 'RECEPTION',
            registeredById: receptionist.id, createdAt: new Date(Date.now() - p.since * 86_400_000),
          },
        });
      });
    }
    patientRows.push({ id: row.id, createdAt: row.createdAt, focus: p.focus });
    if (p.familyOfDemo) {
      motherId = row.id;
      await prisma.familyMember.upsert({
        where: { accountPatientId_memberPatientId: { accountPatientId: patient.id, memberPatientId: row.id } },
        update: {},
        create: { accountPatientId: patient.id, memberPatientId: row.id, relationship: p.familyOfDemo },
      });
    }
  }

  // A month of activity, dated relative to today — only on a database with no visits yet.
  if ((await prisma.visit.count()) === 0) {
    const t0 = Date.now();
    const staffByEmail = async (email: string) => prisma.staff.findFirstOrThrow({ where: { user: { email } }, select: { id: true, userId: true, staffCode: true, fullName: true } });
    const doctors: DemoCtx['doctors'] = {};
    for (const [email, setup] of Object.entries(doctorSetup)) {
      const st = await staffByEmail(email);
      const dept = demoStaff.find((d) => d.email === email)!.dept;
      doctors[email] = { id: st.id, userId: st.userId, staffCode: st.staffCode, name: st.fullName, dept, sessions: setup.sessions.map((x) => ({ days: x.days, start: toMinute(x.start), end: toMinute(x.end), slot: x.slot })) };
    }
    const cat = await prisma.serviceCatalogue.findMany({ select: { id: true, code: true, name: true, pricePaise: true, departmentId: true, taxPercent: true } });
    const meds = await prisma.medicine.findMany({ select: { id: true, code: true, name: true, sellingPricePaise: true, purchasePricePaise: true, catalogueItemId: true } });
    const counts = await seedDemoData(prisma, {
      deptIds,
      doctors,
      staff: {
        lab: (await staffByEmail('lab@medibook.local')).id,
        rad: (await staffByEmail('radiology@medibook.local')).id,
        pharm: pharmacist.id,
        reception: [receptionist.id, (await staffByEmail('reception2@medibook.local')).id],
        accounts: (await staffByEmail('accounts@medibook.local')).id,
      },
      catalogue: Object.fromEntries(cat.map((c) => [c.code, c])),
      medicines: Object.fromEntries(meds.map((m) => [m.code, { ...m, catalogueItemId: m.catalogueItemId!, departmentId: deptIds.PHARM! }])),
      patients: patientRows,
      demoPatientId: patient.id,
      motherPatientId: motherId,
    });
    console.log(`Demo data (${((Date.now() - t0) / 1000).toFixed(0)} s):`, counts);
  } else {
    console.log('Demo data: visits already exist, so the month of demo activity was not regenerated (run `npm run db:reset` for a fresh copy dated from today).');
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
