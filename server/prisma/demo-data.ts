/**
 * Demo data: a month of realistic outpatient activity, dated relative to today (hospital time, IST).
 *
 * Runs once, on an empty clinical database (no visits yet). To rebuild it relative to a new "today",
 * run `npm run db:reset` (drops the database, migrates, seeds).
 *
 * Writes the same rows the services write (visits, notes, vitals, orders, results, referrals, prescriptions,
 * dispensations, stock movements, charges, invoices + lines, payments + allocations, refunds, cash reconciliations),
 * with the same numbering sequences, so screens and reports read it exactly like live data.
 */
import type { Prisma, PrismaClient, PaymentMethod } from '@prisma/client';
import { nextSequence } from '../src/lib/sequence.js';
import { addDays, atLocalMinute, localDateKey, localDayOfWeek } from '../src/lib/time.js';

export interface DemoDoctor { id: string; userId: string; staffCode: string; name: string; dept: string; sessions: { days: number[]; start: number; end: number; slot: number }[] }
export interface DemoCtx {
  deptIds: Record<string, string>;
  doctors: Record<string, DemoDoctor>; // by email
  staff: { lab: string; rad: string; pharm: string; reception: string[]; accounts: string };
  catalogue: Record<string, { id: string; name: string; pricePaise: number; departmentId: string; taxPercent: number }>;
  medicines: Record<string, { id: string; name: string; sellingPricePaise: number; purchasePricePaise: number; catalogueItemId: string; departmentId: string }>;
  patients: { id: string; createdAt: Date; focus: string }[];
  demoPatientId: string;
  motherPatientId: string;
}

/* ---------------- deterministic randomness ---------------- */
let state = 20261118;
const rnd = () => {
  state |= 0; state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
const chance = (p: number) => rnd() < p;
const addMin = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
const dayCode = (d: Date) => localDateKey(d).replace(/-/g, '');

/* ---------------- clinical templates per department ---------------- */
type Rx = { med: string; dose: string; freq: string; days: number; instructions?: string };
interface Condition { complaint: string; diagnosis: string; code: string; subjective: string; assessment: string; plan: string; tests: string[]; optionalTests?: string[]; rx: Rx[] }

const CONDITIONS: Record<string, Condition[]> = {
  CARD: [
    { complaint: 'Chest discomfort on exertion', diagnosis: 'Stable angina', code: 'I20.8', subjective: 'Tightness in the chest after climbing two flights of stairs for 3 weeks, settles with rest in 5 minutes.', assessment: 'Typical exertional angina. Risk factors: hypertension, family history.', plan: 'ECG today, lipid profile. Start antiplatelet and statin. Review with reports; consider TMT.', tests: ['LAB-ECG', 'LAB-LIPID'], optionalTests: ['RAD-ECHO'], rx: [{ med: 'MED-ASP75', dose: '75 mg', freq: '0-1-0', days: 30, instructions: 'After lunch' }, { med: 'MED-ATOR10', dose: '10 mg', freq: '0-0-1', days: 30, instructions: 'At bedtime' }] },
    { complaint: 'Follow-up: high blood pressure', diagnosis: 'Essential hypertension', code: 'I10', subjective: 'Home BP readings 150s/90s. Occasional morning headache. Taking medicines regularly.', assessment: 'Hypertension not at target on monotherapy.', plan: 'Add telmisartan. Low-salt diet, 30 min walk daily. Recheck BP in 2 weeks.', tests: ['LAB-ECG'], rx: [{ med: 'MED-AMLO5', dose: '5 mg', freq: '1-0-0', days: 30 }, { med: 'MED-TELM40', dose: '40 mg', freq: '1-0-0', days: 30 }] },
    { complaint: 'Palpitations', diagnosis: 'Palpitations', code: 'R00.2', subjective: 'Episodes of fast heartbeat lasting a few minutes, 2–3 times a week. No syncope.', assessment: 'Likely benign ectopics; rule out arrhythmia and thyroid cause.', plan: 'ECG and echo. Reduce caffeine. Holter if symptoms persist.', tests: ['LAB-ECG'], optionalTests: ['RAD-ECHO', 'LAB-TSH'], rx: [{ med: 'MED-METO25', dose: '25 mg', freq: '1-0-0', days: 14 }] },
    { complaint: 'Breathlessness and ankle swelling', diagnosis: 'Heart failure with reduced ejection fraction', code: 'I50.2', subjective: 'Breathless on walking 100 m, needs two pillows at night, ankle swelling for 10 days.', assessment: 'Decompensated heart failure, NYHA class II–III.', plan: 'Echo, troponin, chest X-ray. Optimise beta blocker. Daily weight chart.', tests: ['RAD-ECHO', 'LAB-TROP'], optionalTests: ['RAD-CXR'], rx: [{ med: 'MED-METO25', dose: '25 mg', freq: '1-0-0', days: 30 }, { med: 'MED-ASP75', dose: '75 mg', freq: '0-1-0', days: 30 }] },
    { complaint: 'Review after angioplasty', diagnosis: 'Coronary artery disease, post PCI', code: 'I25.1', subjective: 'Six months after stent to LAD. No chest pain. Walking 4 km a day.', assessment: 'Stable post-PCI. Lipids to be rechecked.', plan: 'Continue dual antiplatelets. Lipid profile and ECG. Review in 3 months.', tests: ['LAB-ECG', 'LAB-LIPID'], rx: [{ med: 'MED-CLOP75', dose: '75 mg', freq: '0-1-0', days: 30 }, { med: 'MED-ASP75', dose: '75 mg', freq: '0-1-0', days: 30 }, { med: 'MED-ATOR10', dose: '10 mg', freq: '0-0-1', days: 30 }] },
  ],
  GEN: [
    { complaint: 'Fever and body ache for 3 days', diagnosis: 'Acute febrile illness', code: 'R50.9', subjective: 'Fever up to 101°F with body ache and fatigue for 3 days. No rash, no bleeding.', assessment: 'Viral fever likely; rule out dengue given season.', plan: 'CBC today. Paracetamol, fluids, rest. Return if fever persists beyond 5 days.', tests: ['LAB-CBC'], rx: [{ med: 'MED-PCM650', dose: '650 mg', freq: '1-1-1', days: 3, instructions: 'Only if temperature above 100°F' }] },
    { complaint: 'Follow-up: diabetes', diagnosis: 'Type 2 diabetes mellitus', code: 'E11.9', subjective: 'Known diabetic for 6 years. Fasting sugars 150–170 at home. Diet irregular.', assessment: 'Suboptimal glycaemic control.', plan: 'HbA1c and fasting sugar. Add glimepiride. Refer to dietitian if HbA1c above 8.', tests: ['LAB-HBA1C', 'LAB-FBS'], rx: [{ med: 'MED-METF500', dose: '500 mg', freq: '1-0-1', days: 30, instructions: 'With meals' }, { med: 'MED-GLIM1', dose: '1 mg', freq: '1-0-0', days: 30, instructions: 'Before breakfast' }] },
    { complaint: 'Sore throat and runny nose', diagnosis: 'Acute upper respiratory infection', code: 'J06.9', subjective: 'Sore throat, sneezing and runny nose for 2 days. No breathlessness.', assessment: 'Viral URTI.', plan: 'Symptomatic treatment, steam inhalation, warm fluids.', tests: [], rx: [{ med: 'MED-CETZ10', dose: '10 mg', freq: '0-0-1', days: 5 }, { med: 'MED-PCM650', dose: '650 mg', freq: '1-0-1', days: 3 }] },
    { complaint: 'Burning pain in upper abdomen', diagnosis: 'Gastritis', code: 'K29.7', subjective: 'Epigastric burning after meals for 2 weeks, worse with spicy food. No vomiting.', assessment: 'Acid peptic disease.', plan: 'Pantoprazole before breakfast for 2 weeks. Avoid NSAIDs and late meals.', tests: [], optionalTests: ['RAD-USG-ABD'], rx: [{ med: 'MED-PANT40', dose: '40 mg', freq: '1-0-0', days: 14, instructions: '30 minutes before breakfast' }] },
    { complaint: 'Tiredness and weight gain', diagnosis: 'Hypothyroidism', code: 'E03.9', subjective: 'Tired all the time, gained 4 kg in 3 months, feels cold.', assessment: 'Suspected hypothyroidism.', plan: 'TSH and CBC. Start levothyroxine if TSH raised.', tests: ['LAB-TSH', 'LAB-CBC'], rx: [{ med: 'MED-THYR50', dose: '50 mcg', freq: '1-0-0', days: 30, instructions: 'Empty stomach, early morning' }] },
    { complaint: 'Cough for 2 weeks', diagnosis: 'Acute bronchitis', code: 'J20.9', subjective: 'Productive cough for 2 weeks, low-grade evening fever. Non-smoker.', assessment: 'Lower respiratory infection; rule out pneumonia.', plan: 'Chest X-ray and CBC. Azithromycin for 3 days.', tests: ['RAD-CXR', 'LAB-CBC'], rx: [{ med: 'MED-AZI500', dose: '500 mg', freq: '1-0-0', days: 3 }, { med: 'MED-PCM650', dose: '650 mg', freq: '1-0-1', days: 3 }] },
  ],
  NUTR: [
    { complaint: 'Diet plan for diabetes', diagnosis: 'Type 2 diabetes — medical nutrition therapy', code: 'E11.9', subjective: 'Referred for diet counselling. Eats rice three times a day, sweets after dinner.', assessment: 'High refined-carbohydrate intake; BMI 28.', plan: '1600 kcal plate-method diet, millets twice a day, no sugary drinks. Review in 4 weeks with HbA1c.', tests: [], optionalTests: ['LAB-HBA1C'], rx: [] },
    { complaint: 'Weight management', diagnosis: 'Obesity', code: 'E66.9', subjective: 'Wants to lose weight. Desk job, little exercise, frequent outside food.', assessment: 'BMI 31. Low protein, high fat intake.', plan: '1500 kcal high-protein diet, 8000 steps a day, food diary. Monthly review.', tests: [], optionalTests: ['LAB-LIPID', 'LAB-VITD'], rx: [{ med: 'MED-VITD60K', dose: '60000 IU', freq: '1-0-0', days: 8, instructions: 'Once a week, with milk' }] },
    { complaint: 'Heart-healthy diet after cardiac review', diagnosis: 'Dyslipidaemia — dietary management', code: 'E78.5', subjective: 'Referred by cardiology for diet. Uses ghee daily, fried snacks in the evening.', assessment: 'Saturated-fat-rich diet; LDL above target.', plan: 'DASH-style diet: oats, nuts, fish twice a week; salt under 5 g/day; cooking oil 3 tsp a day.', tests: [], optionalTests: ['LAB-LIPID'], rx: [] },
    { complaint: 'Low energy, poor appetite', diagnosis: 'Vitamin D deficiency', code: 'E55.9', subjective: 'Fatigue and leg aches; little sun exposure.', assessment: 'Probable vitamin D deficiency.', plan: 'Vitamin D level. Weekly cholecalciferol, calcium-rich foods, 20 min morning sun.', tests: ['LAB-VITD'], rx: [{ med: 'MED-VITD60K', dose: '60000 IU', freq: '1-0-0', days: 8, instructions: 'Once a week' }, { med: 'MED-CALD3', dose: '500 mg', freq: '0-1-0', days: 30 }] },
  ],
  ORTHO: [
    { complaint: 'Knee pain while climbing stairs', diagnosis: 'Primary osteoarthritis of knee', code: 'M17.1', subjective: 'Bilateral knee pain for 6 months, worse on stairs and squatting. Morning stiffness 10 minutes.', assessment: 'Early osteoarthritis knees.', plan: 'X-ray both knees. Quadriceps strengthening, weight reduction, analgesics as needed.', tests: ['RAD-XR-KNEE'], rx: [{ med: 'MED-DICL50', dose: '50 mg', freq: '1-0-1', days: 5, instructions: 'After food' }, { med: 'MED-CALD3', dose: '500 mg', freq: '0-1-0', days: 30 }] },
    { complaint: 'Low back pain', diagnosis: 'Mechanical low back pain', code: 'M54.5', subjective: 'Low back pain for 3 weeks after lifting a suitcase. No leg weakness or numbness.', assessment: 'Mechanical back pain, no red flags.', plan: 'X-ray LS spine. Physiotherapy, posture advice, short course of analgesics.', tests: ['RAD-XR-LSS'], rx: [{ med: 'MED-IBU400', dose: '400 mg', freq: '1-0-1', days: 5, instructions: 'After food' }, { med: 'MED-PANT40', dose: '40 mg', freq: '1-0-0', days: 5 }] },
    { complaint: 'Twisted ankle while playing', diagnosis: 'Sprain of ankle', code: 'S93.4', subjective: 'Inversion injury to right ankle during football yesterday. Can bear weight with pain.', assessment: 'Grade 1–2 lateral ligament sprain.', plan: 'RICE, crepe bandage, analgesics. Return to sport in 3 weeks.', tests: [], rx: [{ med: 'MED-IBU400', dose: '400 mg', freq: '1-0-1', days: 5, instructions: 'After food' }] },
    { complaint: 'Shoulder stiffness', diagnosis: 'Adhesive capsulitis of shoulder', code: 'M75.0', subjective: 'Painful, stiff left shoulder for 2 months; cannot comb hair. Diabetic.', assessment: 'Frozen shoulder.', plan: 'Physiotherapy, home exercises, analgesics. MRI if no improvement in 6 weeks.', tests: [], optionalTests: ['RAD-MRI-KNEE'], rx: [{ med: 'MED-DICL50', dose: '50 mg', freq: '1-0-1', days: 7, instructions: 'After food' }] },
  ],
};

const RESULTS: Record<string, { normal: { summary: string; values?: object[] }; abnormal: { summary: string; values?: object[] } }> = {
  'LAB-ECG': { normal: { summary: 'Sinus rhythm, rate 78/min. Normal axis. No ST–T changes.' }, abnormal: { summary: 'Sinus rhythm, rate 92/min. 1 mm ST depression in V4–V6. Suggest TMT/echo correlation.' } },
  'LAB-CBC': {
    normal: { summary: 'Haemogram within normal limits.', values: [{ name: 'Haemoglobin', value: '13.8', unit: 'g/dL', range: '12–16' }, { name: 'WBC', value: '7,200', unit: '/µL', range: '4,000–11,000' }, { name: 'Platelets', value: '2.6 lakh', unit: '/µL', range: '1.5–4.5 lakh' }] },
    abnormal: { summary: 'Low platelets and low WBC — consistent with viral fever; repeat in 48 h.', values: [{ name: 'Haemoglobin', value: '12.9', unit: 'g/dL', range: '12–16' }, { name: 'WBC', value: '3,100', unit: '/µL', range: '4,000–11,000', flag: 'L' }, { name: 'Platelets', value: '0.95 lakh', unit: '/µL', range: '1.5–4.5 lakh', flag: 'L' }] },
  },
  'LAB-LIPID': {
    normal: { summary: 'Lipid profile within target.', values: [{ name: 'Total cholesterol', value: '172', unit: 'mg/dL', range: '<200' }, { name: 'LDL', value: '94', unit: 'mg/dL', range: '<100' }, { name: 'HDL', value: '46', unit: 'mg/dL', range: '>40' }, { name: 'Triglycerides', value: '138', unit: 'mg/dL', range: '<150' }] },
    abnormal: { summary: 'Raised LDL and triglycerides.', values: [{ name: 'Total cholesterol', value: '248', unit: 'mg/dL', range: '<200', flag: 'H' }, { name: 'LDL', value: '162', unit: 'mg/dL', range: '<100', flag: 'H' }, { name: 'HDL', value: '36', unit: 'mg/dL', range: '>40', flag: 'L' }, { name: 'Triglycerides', value: '221', unit: 'mg/dL', range: '<150', flag: 'H' }] },
  },
  'LAB-HBA1C': { normal: { summary: 'HbA1c 6.4% — good control.', values: [{ name: 'HbA1c', value: '6.4', unit: '%', range: '<6.5 (diabetic target <7)' }] }, abnormal: { summary: 'HbA1c 8.6% — poor glycaemic control.', values: [{ name: 'HbA1c', value: '8.6', unit: '%', range: '<7 target', flag: 'H' }] } },
  'LAB-FBS': { normal: { summary: 'Fasting glucose 98 mg/dL.', values: [{ name: 'Fasting glucose', value: '98', unit: 'mg/dL', range: '70–100' }] }, abnormal: { summary: 'Fasting glucose 164 mg/dL.', values: [{ name: 'Fasting glucose', value: '164', unit: 'mg/dL', range: '70–100', flag: 'H' }] } },
  'LAB-TROP': { normal: { summary: 'Troponin I < 0.01 ng/mL — negative.' }, abnormal: { summary: 'Troponin I 0.08 ng/mL — mildly raised. Clinical correlation advised.' } },
  'LAB-TSH': { normal: { summary: 'TSH 2.4 mIU/L — normal.', values: [{ name: 'TSH', value: '2.4', unit: 'mIU/L', range: '0.4–4.0' }] }, abnormal: { summary: 'TSH 9.8 mIU/L — raised, consistent with hypothyroidism.', values: [{ name: 'TSH', value: '9.8', unit: 'mIU/L', range: '0.4–4.0', flag: 'H' }] } },
  'LAB-VITD': { normal: { summary: '25-OH vitamin D 34 ng/mL — sufficient.' }, abnormal: { summary: '25-OH vitamin D 11 ng/mL — deficient.', values: [{ name: '25-OH Vitamin D', value: '11', unit: 'ng/mL', range: '30–100', flag: 'L' }] } },
  'RAD-ECHO': { normal: { summary: 'Normal chamber sizes. LVEF 60%. No regional wall motion abnormality. Valves normal.' }, abnormal: { summary: 'Dilated LV. LVEF 35%. Global hypokinesia. Mild MR.' } },
  'RAD-CXR': { normal: { summary: 'Lung fields clear. Cardiac size normal. No effusion.' }, abnormal: { summary: 'Right lower zone patchy opacity — suggestive of consolidation.' } },
  'RAD-USG-ABD': { normal: { summary: 'Liver, gall bladder, pancreas, kidneys normal. No free fluid.' }, abnormal: { summary: 'Grade 1 fatty liver. Rest normal.' } },
  'RAD-XR-KNEE': { normal: { summary: 'Joint spaces maintained. No bony injury.' }, abnormal: { summary: 'Medial joint space narrowing with marginal osteophytes — Kellgren–Lawrence grade 2.' } },
  'RAD-XR-LSS': { normal: { summary: 'Normal alignment. Disc spaces maintained.' }, abnormal: { summary: 'Straightening of lumbar lordosis; mild L4–L5 disc space reduction.' } },
  'RAD-MRI-KNEE': { normal: { summary: 'No ligament or meniscal tear.' }, abnormal: { summary: 'Grade 2 signal in posterior horn of medial meniscus. No ligament tear.' } },
};

const dosesPerDay = (f: string) => f.split('-').reduce((n, x) => n + Number(x), 0) || 1;

/* ---------------- the generator ---------------- */
export async function seedDemoData(prisma: PrismaClient, ctx: DemoCtx) {
  const now = new Date();
  const today = localDateKey(now);
  const doctorList = Object.values(ctx.doctors);
  const usedSlots = new Set<string>(); // doctorId|iso
  const dailyCollections = new Map<string, { CASH: number; UPI: number; CARD: number; count: number }>();
  const counts = { appointments: 0, visits: 0, orders: 0, results: 0, prescriptions: 0, invoices: 0, payments: 0 };

  const staffTx = prisma as unknown as Prisma.TransactionClient;
  const seq = (key: string) => nextSequence(key, staffTx);

  const consultationItem = (dept: string) => ctx.catalogue[`CONS-${dept}`]!;
  const slotsOf = (d: DemoDoctor, date: string) => {
    const dow = localDayOfWeek(date);
    return d.sessions.filter((s) => s.days.includes(dow)).flatMap((s) => {
      const out: number[] = [];
      for (let m = s.start; m + s.slot <= s.end; m += s.slot) out.push(m);
      return out.map((m) => ({ minute: m, slot: s.slot }));
    });
  };
  const patientFor = (dept: string, at: Date) => {
    const eligible = ctx.patients.filter((p) => p.createdAt <= at);
    const same = eligible.filter((p) => p.focus === dept);
    return pick(same.length && chance(0.75) ? same : eligible);
  };

  // Leave: one GP is away today and tomorrow (board shows "On leave"); an orthopaedician has leave next week.
  const gen3 = ctx.doctors['doctor.gen3@medibook.local']!;
  await prisma.doctorLeave.create({ data: { doctorId: gen3.id, startsAt: atLocalMinute(today, 0), endsAt: atLocalMinute(addDays(today, 2), 0), reason: 'Conference' } });
  const ortho2 = ctx.doctors['doctor.ortho2@medibook.local']!;
  await prisma.doctorLeave.create({ data: { doctorId: ortho2.id, startsAt: atLocalMinute(addDays(today, 6), 0), endsAt: atLocalMinute(addDays(today, 8), 0), reason: 'Personal leave' } });
  const onLeave = (d: DemoDoctor, date: string) => d.id === gen3.id && (date === today || date === addDays(today, 1));

  async function appointment(input: { patientId: string; doctor: DemoDoctor; slotStart: Date; slotMinutes: number; status: 'BOOKED' | 'CHECKED_IN' | 'IN_CONSULTATION' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW'; source?: 'RECEPTION' | 'ONLINE'; reason?: string; token?: number | null; checkedInAt?: Date | null }) {
    usedSlots.add(`${input.doctor.id}|${input.slotStart.toISOString()}`);
    counts.appointments++;
    const created = addMin(input.slotStart, -int(60 * 12, 60 * 24 * 6));
    return prisma.appointment.create({
      data: {
        ref: `APT-${String(await seq('appointment')).padStart(6, '0')}`,
        patientId: input.patientId, doctorId: input.doctor.id, departmentId: ctx.deptIds[input.doctor.dept]!,
        slotStart: input.slotStart, slotEnd: addMin(input.slotStart, input.slotMinutes), status: input.status,
        source: input.source ?? (chance(0.4) ? 'ONLINE' : 'RECEPTION'), reason: input.reason ?? null,
        tokenNumber: input.token ?? null, checkedInAt: input.checkedInAt ?? null,
        cancelledAt: input.status === 'CANCELLED' ? addMin(created, int(60, 600)) : null,
        cancelReason: input.status === 'CANCELLED' ? pick(['Patient travelling', 'Feeling better', 'Clash with work', 'Rescheduling later']) : null,
        createdAt: created < now ? created : now,
      },
      select: { id: true },
    });
  }

  type Stage = 'DONE' | 'TODAY_DONE' | 'IN_CONSULT' | 'WAITING';
  type ChargeDraft = { catalogueItemId: string; departmentId: string; description: string; quantity: number; unitPricePaise: number; taxPercent: number; createdAt: Date; createdById: string; orderId?: string; dispensationId?: string };

  /** A full visit: check-in → consult → note → orders → results → prescription → dispense → bill → payment. */
  async function visit(input: { doctor: DemoDoctor; patientId: string; arrival: Date; type: 'OPD' | 'WALK_IN'; appointmentId?: string; token: number; stage: Stage; condition?: Condition; forceTests?: string[]; referTo?: DemoDoctor | null; referralAnswered?: { orderId: string } | null; payment?: 'PAID' | 'PARTIAL' | 'UNPAID' }) {
    const { doctor, stage } = input;
    const cond = input.condition ?? pick(CONDITIONS[doctor.dept]!);
    const consultStart = addMin(input.arrival, int(5, 25));
    const consultEnd = addMin(consultStart, int(10, 20));
    const status = stage === 'WAITING' ? 'OPEN' : stage === 'IN_CONSULT' ? 'IN_CONSULTATION' : 'COMPLETED';
    const day = dayCode(input.arrival);
    counts.visits++;
    const v = await prisma.visit.create({
      data: {
        visitNumber: `V-${day}-${String(await seq(`visit:${day}`)).padStart(4, '0')}`,
        patientId: input.patientId, appointmentId: input.appointmentId ?? null, departmentId: ctx.deptIds[doctor.dept]!, doctorId: doctor.id,
        type: input.type, status, chiefComplaint: cond.complaint, tokenNumber: input.token,
        startedAt: input.arrival, createdAt: input.arrival,
        consultStartedAt: stage === 'WAITING' ? null : consultStart, endedAt: status === 'COMPLETED' ? consultEnd : null,
      },
      select: { id: true },
    });
    const qe = (type: 'CHECKED_IN' | 'TOKEN_ISSUED' | 'CALLED' | 'CONSULT_STARTED' | 'CONSULT_ENDED', at: Date) => ({ visitId: v.id, appointmentId: input.appointmentId ?? null, patientId: input.patientId, doctorId: doctor.id, type, tokenNumber: input.token, createdAt: at });
    await prisma.queueEvent.createMany({
      data: [
        qe('CHECKED_IN', input.arrival), qe('TOKEN_ISSUED', input.arrival),
        ...(stage !== 'WAITING' ? [qe('CALLED', consultStart), qe('CONSULT_STARTED', consultStart)] : []),
        ...(status === 'COMPLETED' ? [qe('CONSULT_ENDED', consultEnd)] : []),
      ],
    });
    if (input.referralAnswered) {
      await prisma.referral.update({ where: { orderId: input.referralAnswered.orderId }, data: { toVisitId: v.id, toDoctorId: doctor.id } });
      await prisma.order.update({ where: { id: input.referralAnswered.orderId }, data: { status: status === 'COMPLETED' ? 'COMPLETED' : 'IN_PROGRESS', targetDoctorId: doctor.id, startedAt: input.arrival, completedAt: status === 'COMPLETED' ? consultEnd : null } });
    }
    if (stage === 'WAITING') return { visitId: v.id, referralOrderId: null };

    const noteAt = addMin(consultStart, 4);
    await prisma.vital.create({
      data: {
        visitId: v.id, recordedById: doctor.id, recordedAt: noteAt, pulseBpm: int(64, 96), systolicMmHg: doctor.dept === 'CARD' ? int(124, 158) : int(110, 138), diastolicMmHg: int(72, 94),
        temperatureC: cond.code === 'R50.9' ? `${int(380, 388) / 10}` : `${int(365, 372) / 10}`, spo2Percent: int(95, 99), weightKg: `${int(52, 92)}.${int(0, 9)}`,
      },
    });
    if (stage === 'IN_CONSULT') return { visitId: v.id, referralOrderId: null };

    await prisma.clinicalNote.create({
      data: {
        visitId: v.id, authorId: doctor.id, type: input.referralAnswered ? 'REFERRAL_RESPONSE' : 'CONSULTATION',
        subjective: cond.subjective, objective: 'Vitals recorded. General examination unremarkable apart from the findings noted.', assessment: cond.assessment, plan: cond.plan,
        diagnosis: cond.diagnosis, diagnosisCode: cond.code, createdAt: noteAt, updatedAt: consultEnd,
      },
    });

    const charges: ChargeDraft[] = [];
    const cons = consultationItem(doctor.dept);
    charges.push({ catalogueItemId: cons.id, departmentId: cons.departmentId, description: `Consultation – ${doctor.name}`, quantity: 1, unitPricePaise: cons.pricePaise, taxPercent: 0, createdAt: consultEnd, createdById: doctor.id });

    // Tests and scans
    const tests = input.forceTests ?? [...cond.tests, ...(cond.optionalTests ?? []).filter(() => chance(0.3))];
    for (const code of tests) {
      const item = ctx.catalogue[code]!;
      const isLab = code.startsWith('LAB-');
      const orderedAt = addMin(consultStart, 8);
      const startedAt = addMin(consultEnd, int(10, 40));
      const readyAt = addMin(startedAt, isLab ? int(40, 180) : int(30, 120));
      let ostatus: 'ORDERED' | 'IN_PROGRESS' | 'RESULT_READY' = 'RESULT_READY';
      if (stage === 'TODAY_DONE') ostatus = readyAt < now && chance(0.55) ? 'RESULT_READY' : startedAt < now && chance(0.5) ? 'IN_PROGRESS' : 'ORDERED';
      const tech = isLab ? ctx.staff.lab : ctx.staff.rad;
      counts.orders++;
      const o = await prisma.order.create({
        data: {
          orderNumber: `ORD-${String(await seq('order')).padStart(6, '0')}`, visitId: v.id, patientId: input.patientId, type: isLab ? 'LAB' : 'RADIOLOGY', status: ostatus,
          priority: code === 'LAB-TROP' ? 'URGENT' : chance(0.1) ? 'URGENT' : 'ROUTINE', orderingDoctorId: doctor.id, targetDepartmentId: item.departmentId, catalogueItemId: item.id, title: item.name,
          clinicalNotes: cond.diagnosis, createdAt: orderedAt,
          startedAt: ostatus === 'ORDERED' ? null : startedAt, assignedToId: ostatus === 'ORDERED' ? null : tech,
          completedAt: ostatus === 'RESULT_READY' ? readyAt : null, resultReadyAt: ostatus === 'RESULT_READY' ? readyAt : null,
        },
        select: { id: true },
      });
      if (ostatus === 'RESULT_READY') {
        const abnormal = chance(0.35);
        const r = RESULTS[code]![abnormal ? 'abnormal' : 'normal'];
        counts.results++;
        await prisma.orderResult.create({ data: { orderId: o.id, reportedById: tech, summary: r.summary, values: (r.values ?? undefined) as Prisma.InputJsonValue | undefined, isAbnormal: abnormal, reportedAt: readyAt } });
        charges.push({ catalogueItemId: item.id, departmentId: item.departmentId, description: item.name, quantity: 1, unitPricePaise: item.pricePaise, taxPercent: item.taxPercent, createdAt: readyAt, createdById: tech, orderId: o.id });
      }
    }

    // Referral (e.g. cardiology → nutrition)
    let referralOrderId: string | null = null;
    if (input.referTo) {
      counts.orders++;
      const target = input.referTo;
      const reason = doctor.dept === 'CARD' ? `Diet counselling for ${cond.diagnosis.toLowerCase()}: low-salt, low-fat plan and weight reduction.` : `Please assess and advise: ${cond.diagnosis}.`;
      const o = await prisma.order.create({
        data: {
          orderNumber: `ORD-${String(await seq('order')).padStart(6, '0')}`, visitId: v.id, patientId: input.patientId, type: 'REFERRAL', status: 'ORDERED', priority: 'ROUTINE',
          orderingDoctorId: doctor.id, targetDepartmentId: ctx.deptIds[target.dept]!, targetDoctorId: target.id, title: `Referral to ${target.name} · ${target.dept === 'NUTR' ? 'Nutrition' : target.dept}`,
          clinicalNotes: reason, createdAt: addMin(consultStart, 10),
        },
        select: { id: true },
      });
      await prisma.referral.create({ data: { orderId: o.id, patientId: input.patientId, fromVisitId: v.id, fromDoctorId: doctor.id, toDepartmentId: ctx.deptIds[target.dept]!, toDoctorId: target.id, reason, createdAt: addMin(consultStart, 10) } });
      referralOrderId = o.id;
    }

    // Prescription → pharmacy
    if (cond.rx.length) {
      const dispenseAt = addMin(consultEnd, int(15, 45));
      const dispensed = stage === 'DONE' || (dispenseAt < now && chance(0.5));
      counts.orders++;
      counts.prescriptions++;
      const items = cond.rx.map((r) => ({ ...r, m: ctx.medicines[r.med]!, quantity: Math.max(1, r.med === 'MED-VITD60K' ? Math.ceil(r.days / 7) : dosesPerDay(r.freq) * r.days) }));
      const o = await prisma.order.create({
        data: {
          orderNumber: `ORD-${String(await seq('order')).padStart(6, '0')}`, visitId: v.id, patientId: input.patientId, type: 'MEDICATION', status: dispensed ? 'COMPLETED' : 'ORDERED', priority: 'ROUTINE',
          orderingDoctorId: doctor.id, targetDepartmentId: ctx.deptIds.PHARM!, title: items.map((i) => i.m.name).join(', ').slice(0, 200), createdAt: addMin(consultStart, 12),
          completedAt: dispensed ? dispenseAt : null,
        },
        select: { id: true },
      });
      const rx = await prisma.prescription.create({
        data: { visitId: v.id, patientId: input.patientId, doctorId: doctor.id, orderId: o.id, status: dispensed ? 'DISPENSED' : 'ACTIVE', createdAt: addMin(consultStart, 12), updatedAt: dispensed ? dispenseAt : addMin(consultStart, 12) },
        select: { id: true },
      });
      for (const it of items) {
        const pi = await prisma.prescriptionItem.create({
          data: { prescriptionId: rx.id, medicineId: it.m.id, medicineName: it.m.name, dose: it.dose, frequency: it.freq, durationDays: it.days, route: 'Oral', instructions: it.instructions ?? null, quantity: it.quantity, dispensedQuantity: dispensed ? it.quantity : 0 },
          select: { id: true },
        });
        if (!dispensed) continue;
        const d = await prisma.dispensation.create({
          data: { prescriptionItemId: pi.id, medicineId: it.m.id, quantity: it.quantity, unitPricePaise: it.m.sellingPricePaise, unitCostPaise: it.m.purchasePricePaise, dispensedById: ctx.staff.pharm, dispensedAt: dispenseAt },
          select: { id: true },
        });
        await prisma.stockMovement.create({ data: { medicineId: it.m.id, type: 'DISPENSE', quantity: -it.quantity, unitCostPaise: it.m.purchasePricePaise, dispensationId: d.id, reference: `Rx ${o.id.slice(0, 8)}`, performedById: ctx.staff.pharm, createdAt: dispenseAt } });
        await prisma.medicine.update({ where: { id: it.m.id }, data: { stockQuantity: { decrement: it.quantity } } });
        charges.push({ catalogueItemId: it.m.catalogueItemId, departmentId: it.m.departmentId, description: `${it.m.name} × ${it.quantity}`, quantity: it.quantity, unitPricePaise: it.m.sellingPricePaise, taxPercent: 5, createdAt: dispenseAt, createdById: ctx.staff.pharm, dispensationId: d.id });
      }
    }

    // One invoice per visit, then the counter payment.
    charges.sort((a, b) => +a.createdAt - +b.createdAt);
    const first = charges[0]!.createdAt;
    const invDay = dayCode(first);
    const lines = charges.map((c) => {
      const total = c.unitPricePaise * c.quantity;
      return { ...c, totalPaise: total, taxPaise: Math.round((total * c.taxPercent) / 100) };
    });
    const subtotal = lines.reduce((n, l) => n + l.totalPaise, 0);
    const tax = lines.reduce((n, l) => n + l.taxPaise, 0);
    const total = subtotal + tax;
    counts.invoices++;
    const inv = await prisma.invoice.create({
      data: { invoiceNumber: `INV-${invDay}-${String(await seq(`inv:${invDay}`)).padStart(4, '0')}`, visitId: v.id, patientId: input.patientId, status: 'ISSUED', subtotalPaise: subtotal, taxPaise: tax, totalPaise: total, issuedAt: first, createdAt: first },
      select: { id: true },
    });
    for (const l of lines) {
      const ch = await prisma.charge.create({
        data: { visitId: v.id, catalogueItemId: l.catalogueItemId, departmentId: l.departmentId, orderId: l.orderId ?? null, dispensationId: l.dispensationId ?? null, description: l.description, quantity: l.quantity, unitPricePaise: l.unitPricePaise, totalPaise: l.totalPaise, status: 'INVOICED', createdById: l.createdById, createdAt: l.createdAt },
        select: { id: true },
      });
      await prisma.invoiceLine.create({ data: { invoiceId: inv.id, chargeId: ch.id, departmentId: l.departmentId, description: l.description, quantity: l.quantity, unitPricePaise: l.unitPricePaise, totalPaise: l.totalPaise, taxPercent: l.taxPercent, taxPaise: l.taxPaise } });
    }

    const last = charges[charges.length - 1]!.createdAt;
    const mode = input.payment ?? (stage === 'TODAY_DONE' ? (chance(0.45) ? 'PAID' : 'UNPAID') : chance(0.05) ? 'UNPAID' : chance(0.04) ? 'PARTIAL' : 'PAID');
    const paidAt = addMin(last, int(3, 20));
    if (mode !== 'UNPAID' && paidAt < now) {
      const amount = mode === 'PAID' ? total : charges[0]!.unitPricePaise; // partial = consultation only
      const method: PaymentMethod = pick(['UPI', 'UPI', 'UPI', 'CASH', 'CASH', 'CARD']);
      const rDay = dayCode(paidAt);
      counts.payments++;
      const pay = await prisma.payment.create({
        data: {
          receiptNumber: `RCPT-${rDay}-${String(await seq(`rcpt:${rDay}`)).padStart(4, '0')}`, patientId: input.patientId, method, status: 'CONFIRMED', amountPaise: amount,
          reference: method === 'UPI' ? String(int(100000, 999999)) + String(int(100000, 999999)) : method === 'CARD' ? String(int(1000, 9999)) : null,
          idempotencyKey: `seed-${v.id}`, receivedById: chance(0.85) ? pick(ctx.staff.reception) : ctx.staff.accounts, receivedAt: paidAt, createdAt: paidAt,
          allocations: { create: { invoiceId: inv.id, amountPaise: amount, createdAt: paidAt } },
        },
        select: { id: true },
      });
      await prisma.invoice.update({ where: { id: inv.id }, data: { paidPaise: amount, status: amount >= total ? 'PAID' : 'PARTIALLY_PAID' } });
      const key = localDateKey(paidAt);
      const agg = dailyCollections.get(key) ?? { CASH: 0, UPI: 0, CARD: 0, count: 0 };
      agg[method] += amount;
      agg.count++;
      dailyCollections.set(key, agg);
      return { visitId: v.id, invoiceId: inv.id, paymentId: pay.id, paidPaise: amount, referralOrderId };
    }
    return { visitId: v.id, invoiceId: inv.id, paymentId: null, paidPaise: 0, referralOrderId };
  }

  const tokens = new Map<string, number>();
  const nextToken = async (doctorId: string, date: string) => {
    const n = await seq(`token:${doctorId}:${date}`);
    tokens.set(`${doctorId}|${date}`, n);
    return n;
  };

  /* ---------- 1. The demo patient's own story (portal: past visits, results, a bill to pay, an upcoming appointment) ---------- */
  const ananya = ctx.doctors['doctor@medibook.local']!;
  const sneha = ctx.doctors['doctor.nutrition@medibook.local']!;
  const vikram = ctx.doctors['doctor.gen@medibook.local']!;
  {
    const d1 = addDays(today, -20);
    const slot1 = slotsOf(ananya, d1)[4] ?? slotsOf(ananya, d1)[0]!;
    const s1 = atLocalMinute(d1, slot1.minute);
    const t1 = await nextToken(ananya.id, d1);
    const a1 = await appointment({ patientId: ctx.demoPatientId, doctor: ananya, slotStart: s1, slotMinutes: slot1.slot, status: 'COMPLETED', source: 'ONLINE', reason: 'Chest discomfort on exertion', token: t1, checkedInAt: addMin(s1, -10) });
    const r1 = await visit({ doctor: ananya, patientId: ctx.demoPatientId, arrival: addMin(s1, -10), type: 'OPD', appointmentId: a1.id, token: t1, stage: 'DONE', condition: CONDITIONS.CARD![0], forceTests: ['LAB-ECG', 'LAB-LIPID'], referTo: sneha, payment: 'PAID' });
    const d2 = addDays(today, -14);
    const slot2 = slotsOf(sneha, d2)[2] ?? slotsOf(sneha, d2)[0]!;
    const s2 = atLocalMinute(d2, slot2.minute);
    const t2 = await nextToken(sneha.id, d2);
    await prisma.order.update({ where: { id: r1.referralOrderId! }, data: { status: 'SCHEDULED', scheduledFor: s2 } });
    const a2 = await appointment({ patientId: ctx.demoPatientId, doctor: sneha, slotStart: s2, slotMinutes: slot2.slot, status: 'COMPLETED', source: 'RECEPTION', reason: 'Referral from cardiology', token: t2, checkedInAt: addMin(s2, -10) });
    await visit({ doctor: sneha, patientId: ctx.demoPatientId, arrival: addMin(s2, -10), type: 'OPD', appointmentId: a2.id, token: t2, stage: 'DONE', condition: CONDITIONS.NUTR![2], forceTests: [], referralAnswered: { orderId: r1.referralOrderId! }, payment: 'PAID' });
    const d3 = addDays(today, -5);
    const t3 = await nextToken(vikram.id, d3);
    await visit({ doctor: vikram, patientId: ctx.demoPatientId, arrival: atLocalMinute(d3, 18 * 60 + 10), type: 'WALK_IN', token: t3, stage: 'DONE', condition: CONDITIONS.GEN![0], forceTests: ['LAB-CBC'], payment: 'UNPAID' });
    // his mother (family member on his account)
    const d4 = addDays(today, -9);
    const t4 = await nextToken(vikram.id, d4);
    await visit({ doctor: vikram, patientId: ctx.motherPatientId, arrival: atLocalMinute(d4, 10 * 60 + 20), type: 'WALK_IN', token: t4, stage: 'DONE', condition: CONDITIONS.GEN![1], payment: 'PAID' });
    // upcoming: cardiology review in 3 days (booked online)
    const d5 = addDays(today, 3);
    const slot5 = slotsOf(ananya, d5)[3] ?? slotsOf(ananya, addDays(d5, 1))[3]!;
    await appointment({ patientId: ctx.demoPatientId, doctor: ananya, slotStart: atLocalMinute(slotsOf(ananya, d5).length ? d5 : addDays(d5, 1), slot5.minute), slotMinutes: slot5.slot, status: 'BOOKED', source: 'ONLINE', reason: 'Review with lipid report' });
  }

  /* ---------- Mid-month restock of the fast movers (purchase entries, like Stock-in on the pharmacy screen) ---------- */
  for (const code of ['MED-ASP75', 'MED-METF500', 'MED-ATOR10']) {
    const m = ctx.medicines[code]!;
    await prisma.stockMovement.create({ data: { medicineId: m.id, type: 'PURCHASE', quantity: 2000, unitCostPaise: m.purchasePricePaise, reference: 'Restock – PO 2026/114', performedById: ctx.staff.pharm, createdAt: atLocalMinute(addDays(today, -15), 11 * 60) } });
    await prisma.medicine.update({ where: { id: m.id }, data: { stockQuantity: { increment: 2000 } } });
  }

  /* ---------- 2. Thirty days of history + today ---------- */
  const perDay: Record<string, [number, number]> = { CARD: [2, 4], GEN: [3, 5], NUTR: [1, 2], ORTHO: [2, 3] };
  const nutritionists = doctorList.filter((d) => d.dept === 'NUTR');
  const openReferrals: { orderId: string; patientId: string; at: Date; target: DemoDoctor }[] = [];

  for (let offset = -30; offset <= 0; offset++) {
    const date = addDays(today, offset);
    const isToday = offset === 0;
    for (const doctor of doctorList) {
      if (onLeave(doctor, date)) continue;
      const slots = slotsOf(doctor, date);
      if (!slots.length) continue;
      const [lo, hi] = perDay[doctor.dept]!;
      const n = Math.min(slots.length, int(lo, hi) + (isToday ? 2 : 0));
      const chosen = [...slots].sort(() => rnd() - 0.5).slice(0, n).sort((a, b) => a.minute - b.minute);
      const demoDoctor = doctor.id === ananya.id || doctor.id === sneha.id; // keep the demo doctors free to see the walk-in
      let inConsultUsed = false;
      for (const s of chosen) {
        const slotStart = atLocalMinute(date, s.minute);
        if (usedSlots.has(`${doctor.id}|${slotStart.toISOString()}`)) continue;
        const patient = patientFor(doctor.dept, slotStart);
        const cond = pick(CONDITIONS[doctor.dept]!);
        const walkIn = chance(0.3);

        // Stage relative to now
        let stage: Stage | 'BOOKED' = 'DONE';
        if (isToday) {
          const mins = (now.getTime() - slotStart.getTime()) / 60_000;
          if (mins > 45) stage = 'TODAY_DONE';
          else if (mins > 0 && !inConsultUsed && !demoDoctor) { stage = 'IN_CONSULT'; inConsultUsed = true; }
          else if (mins > -40) stage = 'WAITING';
          else stage = 'BOOKED';
        }
        if (stage === 'BOOKED') {
          await appointment({ patientId: patient.id, doctor, slotStart, slotMinutes: s.slot, status: 'BOOKED', reason: cond.complaint });
          continue;
        }
        if (!isToday && !walkIn && chance(0.06)) {
          await appointment({ patientId: patient.id, doctor, slotStart, slotMinutes: s.slot, status: chance(0.5) ? 'CANCELLED' : 'NO_SHOW', reason: cond.complaint });
          continue;
        }
        const token = await nextToken(doctor.id, date);
        const arrival = addMin(slotStart, walkIn ? int(-30, 5) : int(-15, -3));
        // A nutritionist first sees a patient an earlier cardiology referral sent them (booked by reception, like the live flow).
        const refIdx = doctor.dept === 'NUTR' && !isToday ? openReferrals.findIndex((r) => r.target.id === doctor.id && arrival.getTime() - r.at.getTime() > 86_400_000) : -1;
        const ref = refIdx >= 0 ? openReferrals.splice(refIdx, 1)[0]! : null;
        const patientId = ref?.patientId ?? patient.id;
        const useAppt = ref ? true : !walkIn;
        if (ref) await prisma.order.update({ where: { id: ref.orderId }, data: { status: 'SCHEDULED', scheduledFor: slotStart } });
        let appointmentId: string | undefined;
        if (useAppt) {
          const apptStatus = stage === 'WAITING' ? 'CHECKED_IN' : stage === 'IN_CONSULT' ? 'IN_CONSULTATION' : 'COMPLETED';
          appointmentId = (await appointment({ patientId, doctor, slotStart, slotMinutes: s.slot, status: apptStatus, source: ref ? 'RECEPTION' : undefined, reason: ref ? 'Referral from cardiology' : cond.complaint, token, checkedInAt: arrival })).id;
        }
        const referTo = doctor.dept === 'CARD' && stage !== 'WAITING' && stage !== 'IN_CONSULT' && chance(0.18) ? pick(nutritionists) : null;
        const r = await visit({
          doctor, patientId, arrival, type: useAppt ? 'OPD' : 'WALK_IN', appointmentId, token, stage,
          condition: ref ? CONDITIONS.NUTR![2] : cond, referTo, referralAnswered: ref ? { orderId: ref.orderId } : null,
        });
        if ('referralOrderId' in r && r.referralOrderId && referTo) openReferrals.push({ orderId: r.referralOrderId, patientId, at: arrival, target: referTo });
      }
    }
  }
  // Referrals never booked stay ORDERED: they show on the reception board as "to book".

  /* ---------- 3. Upcoming bookings (next 7 days) ---------- */
  for (let offset = 1; offset <= 7; offset++) {
    const date = addDays(today, offset);
    for (const doctor of doctorList) {
      if (onLeave(doctor, date) || (doctor.id === ortho2.id && offset >= 6)) continue;
      const slots = slotsOf(doctor, date);
      const n = Math.min(slots.length, int(1, offset <= 2 ? 4 : 2));
      for (const s of [...slots].sort(() => rnd() - 0.5).slice(0, n)) {
        const slotStart = atLocalMinute(date, s.minute);
        if (usedSlots.has(`${doctor.id}|${slotStart.toISOString()}`)) continue;
        await appointment({ patientId: patientFor(doctor.dept, now).id, doctor, slotStart, slotMinutes: s.slot, status: 'BOOKED', reason: pick(CONDITIONS[doctor.dept]!).complaint });
      }
    }
  }

  /* ---------- 4. Refunds: one waiting for accounts, one rejected ---------- */
  const paidRecent = await prisma.payment.findMany({ where: { receivedAt: { gte: atLocalMinute(addDays(today, -10), 0), lt: atLocalMinute(today, 0) } }, orderBy: { receivedAt: 'desc' }, take: 6, select: { id: true, method: true, amountPaise: true, receivedAt: true, allocations: { select: { invoiceId: true } } } });
  if (paidRecent.length >= 2) {
    const [a, b] = paidRecent;
    await prisma.refund.create({ data: { paymentId: a!.id, invoiceId: a!.allocations[0]!.invoiceId, amountPaise: Math.min(a!.amountPaise, 30000), method: a!.method, reason: 'Test billed twice — patient had the ECG done once', status: 'REQUESTED', requestedById: pick(ctx.staff.reception), createdAt: addMin(a!.receivedAt, 90) } });
    await prisma.refund.create({ data: { paymentId: b!.id, invoiceId: b!.allocations[0]!.invoiceId, amountPaise: Math.min(b!.amountPaise, 20000), method: b!.method, reason: 'Patient asked for a refund of the consultation fee', status: 'REJECTED', requestedById: pick(ctx.staff.reception), approvedById: ctx.staff.accounts, decisionNote: 'Consultation was completed; fee is not refundable', createdAt: addMin(b!.receivedAt, 60), processedAt: addMin(b!.receivedAt, 300) } });
  }

  /* ---------- 5. Counter closed every past day (one day was ₹200 short) ---------- */
  let shortDone = false;
  for (const [date, agg] of [...dailyCollections.entries()].sort()) {
    if (date >= today) continue;
    const short = !shortDone && date === addDays(today, -6) ? 20000 : 0;
    if (short) shortDone = true;
    await prisma.cashReconciliation.create({
      data: {
        businessDate: date, expectedCashPaise: agg.CASH, expectedUpiPaise: agg.UPI, expectedCardPaise: agg.CARD, countedCashPaise: agg.CASH - short, differencePaise: -short,
        paymentCount: agg.count, note: short ? 'Short by ₹200 — change given twice to one patient; reported to accounts' : null, closedById: ctx.staff.reception[0]!, createdAt: atLocalMinute(date, 21 * 60 + 15),
      },
    });
  }

  return counts;
}
