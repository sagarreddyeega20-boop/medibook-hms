import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { atLocalMinute, addDays, isDateKey, localDateKey, localMidnight } from '../../lib/time.js';
import { validate } from '../../lib/validate.js';
import { clientIp, getSession, requireAnyPermission, requireAuth, requirePermission } from '../auth/auth.middleware.js';
import { patientsService } from '../patients/patients.service.js';
import { staffService } from '../staff/staff.service.js';
import { schedulingService, type Slot } from './scheduling.service.js';

/**
 * HTTP routes for the scheduling module, mounted at /api/scheduling.
 * Reception, the patient portal and the chatbot all use these same booking endpoints.
 */
export const schedulingRouter: Router = Router();

const actor = (req: Request, res: Response) => ({ session: getSession(res), ip: clientIp(req) });
const uuid = z.string().uuid();
const dateKey = z.string().refine(isDateKey, 'Use YYYY-MM-DD');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const toMinute = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Who can book: reception (anyone) or a patient (self + family). */
const canBook = requireAnyPermission('appointments:book', 'self:book');
/** Who can browse doctors and slots. */
const canBrowse = requireAnyPermission('appointments:book', 'self:book', 'reception:read', 'schedules:manage');

schedulingRouter.use(requireAuth);

/* ---------------- Directory: departments, doctors, slots ---------------- */

schedulingRouter.get('/departments', canBrowse, async (_req, res) => {
  const [departments, doctors] = await Promise.all([staffService.departments(), staffService.listDoctors()]);
  res.json({
    departments: departments
      .filter((d) => d.kind === 'CLINICAL')
      .map((d) => ({ ...d, doctorCount: doctors.filter((x) => x.department?.id === d.id).length })),
  });
});

schedulingRouter.get(
  '/doctors',
  canBrowse,
  validate({ query: z.object({ departmentId: uuid.optional(), from: dateKey.optional() }) }),
  async (_req, res) => {
    const q = res.locals.valid.query;
    res.json({ doctors: await schedulingService.directory({ departmentId: q.departmentId, fromDate: q.from }) });
  },
);

/** A doctor's slots for one day. Patients see availability only, never who booked. */
schedulingRouter.get(
  '/doctors/:id/slots',
  canBrowse,
  validate({ params: z.object({ id: uuid }), query: z.object({ date: dateKey.optional() }) }),
  async (_req, res) => {
    const s = getSession(res);
    const date = res.locals.valid.query.date ?? localDateKey();
    if (date > addDays(localDateKey(), 90)) throw AppError.badRequest('Bookings open up to 90 days ahead');
    const doctor = await staffService.doctorById(res.locals.valid.params.id);
    const day = await schedulingService.daySlots(doctor.id, date, s.userId);
    const staff = s.kind === 'STAFF';
    const strip = (x: Slot): Slot => ({ start: x.start, end: x.end, state: x.bookable ? 'FREE' : x.state === 'HELD' && !x.heldByMe ? 'HELD' : x.state === 'FREE' ? 'FREE' : 'BOOKED', past: x.past, bookable: x.bookable, heldByMe: x.heldByMe });
    res.json({
      doctor: { id: doctor.id, name: doctor.fullName, specialty: doctor.specialty, department: doctor.department, consultationFeePaise: doctor.consultationFeePaise },
      date,
      onLeave: day.leaves.length > 0 && day.slots.length === 0,
      slots: staff ? day.slots : day.slots.filter((x) => !x.offSchedule).map(strip),
    });
  },
);

/* ---------------- Holds (Redis, 10 minutes) ---------------- */

schedulingRouter.post(
  '/holds',
  canBook,
  validate({ body: z.object({ doctorId: uuid, slotStart: z.string().datetime({ offset: true }).transform((s) => new Date(s)) }) }),
  async (req, res) => {
    res.status(201).json({ hold: await schedulingService.hold(actor(req, res), res.locals.valid.body) });
  },
);

schedulingRouter.delete('/holds/:holdId', canBook, validate({ params: z.object({ holdId: uuid }) }), async (req, res) => {
  await schedulingService.releaseHold(actor(req, res), res.locals.valid.params.holdId);
  res.status(204).end();
});

/* ---------------- Appointments ---------------- */

schedulingRouter.post(
  '/appointments',
  canBook,
  validate({ body: z.object({ holdId: uuid, patientId: uuid, reason: z.string().trim().max(300).optional(), referralOrderId: uuid.optional() }) }),
  async (req, res) => {
    res.status(201).json({ appointment: await schedulingService.book(actor(req, res), res.locals.valid.body) });
  },
);

/** Portal: the signed-in patient's and their family's appointments. */
schedulingRouter.get('/appointments/mine', requirePermission('self:read'), async (_req, res) => {
  const ids = await patientsService.accessiblePatientIds(getSession(res).userId);
  res.json({ appointments: await schedulingService.listForPatients(ids) });
});

/** Reception: one patient's appointments. */
schedulingRouter.get(
  '/appointments',
  requirePermission('appointments:book'),
  validate({ query: z.object({ patientId: uuid }) }),
  async (_req, res) => {
    res.json({ appointments: await schedulingService.listForPatients([res.locals.valid.query.patientId]) });
  },
);

schedulingRouter.get(
  '/appointments/by-ref/:ref',
  canBook,
  validate({ params: z.object({ ref: z.string().trim().regex(/^APT-\d{1,10}$/i, 'Booking refs look like APT-000123') }) }),
  async (req, res) => {
    res.json({ appointment: await schedulingService.findByRef(actor(req, res), res.locals.valid.params.ref) });
  },
);

schedulingRouter.post(
  '/appointments/:id/cancel',
  canBook,
  validate({ params: z.object({ id: uuid }), body: z.object({ reason: z.string().trim().min(3, 'Give a short reason for cancelling').max(300) }) }),
  async (req, res) => {
    res.json({ appointment: await schedulingService.cancel(actor(req, res), res.locals.valid.params.id, res.locals.valid.body.reason) });
  },
);

schedulingRouter.post(
  '/appointments/:id/reschedule',
  canBook,
  validate({ params: z.object({ id: uuid }), body: z.object({ holdId: uuid }) }),
  async (req, res) => {
    res.json({ appointment: await schedulingService.reschedule(actor(req, res), res.locals.valid.params.id, res.locals.valid.body.holdId) });
  },
);

/* ---------------- Weekly schedules and leaves (admin) ---------------- */

const manage = requirePermission('schedules:manage');

schedulingRouter.get('/doctors/:id/schedule', manage, validate({ params: z.object({ id: uuid }) }), async (_req, res) => {
  const id = res.locals.valid.params.id;
  const [schedule, leaves] = await Promise.all([schedulingService.getSchedule(id), schedulingService.listLeaves(id)]);
  res.json({ schedule, leaves });
});

schedulingRouter.put(
  '/doctors/:id/schedule',
  manage,
  validate({
    params: z.object({ id: uuid }),
    body: z.object({
      sessions: z
        .array(z.object({ dayOfWeek: z.number().int().min(0).max(6), start: time, end: time, slotMinutes: z.number().int().min(5).max(120) }))
        .max(28),
    }),
  }),
  async (req, res) => {
    const sessions = res.locals.valid.body.sessions.map((s: { dayOfWeek: number; start: string; end: string; slotMinutes: number }) => ({
      dayOfWeek: s.dayOfWeek, startMinute: toMinute(s.start), endMinute: toMinute(s.end), slotMinutes: s.slotMinutes,
    }));
    res.json({ schedule: await schedulingService.replaceSchedule(actor(req, res), res.locals.valid.params.id, sessions) });
  },
);

/** Leave in hospital-local dates; without times it covers whole days (start date 00:00 → day after end date 00:00). */
schedulingRouter.post(
  '/doctors/:id/leaves',
  manage,
  validate({
    params: z.object({ id: uuid }),
    body: z
      .object({ startDate: dateKey, endDate: dateKey, startTime: time.optional(), endTime: time.optional(), reason: z.string().trim().max(200).optional() })
      .refine((b) => b.endDate >= b.startDate, { message: 'The end date must be on or after the start date', path: ['endDate'] }),
  }),
  async (req, res) => {
    const b = res.locals.valid.body;
    const startsAt = atLocalMinute(b.startDate, b.startTime ? toMinute(b.startTime) : 0);
    const endsAt = b.endTime ? atLocalMinute(b.endDate, toMinute(b.endTime)) : localMidnight(addDays(b.endDate, 1));
    res.status(201).json(await schedulingService.addLeave(actor(req, res), res.locals.valid.params.id, { startsAt, endsAt, reason: b.reason }));
  },
);

schedulingRouter.delete('/leaves/:id', manage, validate({ params: z.object({ id: uuid }) }), async (req, res) => {
  await schedulingService.removeLeave(actor(req, res), res.locals.valid.params.id);
  res.status(204).end();
});
