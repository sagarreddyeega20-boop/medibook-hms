import { AppError } from '../../lib/errors.js';
import { AuditAction, auditService } from '../audit/audit.service.js';
import type { Actor } from '../auth/care-access.service.js';
import { billingService } from '../billing/billing.service.js';
import { ordersService } from '../orders/orders.service.js';
import { patientsService } from '../patients/patients.service.js';
import { schedulingService } from '../scheduling/scheduling.service.js';
import { staffService } from '../staff/staff.service.js';
import { presentNote, visitsService, type VisitRow } from './visits.service.js';

/**
 * Patient portal: the patient's (and their family's) own visits — history grouped by journey, and one visit's
 * patient-facing detail. Enforced here, on the server:
 *   - a patient reads only visits of their household (self + family members, the existing portal rule) → else 403, audited;
 *   - only patient-facing fields leave the server: diagnosis and advice (never complaint / findings / internal notes),
 *     prescriptions, results ONLY once RESULT_READY, referrals, the bill summary;
 *   - every view of a visit's details writes a VIEW row to audit_logs, like every other clinical read.
 *
 * A journey = visits connected by referrals (from visit → referral → the visit booked from it), at any depth.
 */

type Referral = Awaited<ReturnType<typeof ordersService.referralLinks>>[number];

/** Connected components of visits joined by referral edges (union-find). */
function journeys(visits: VisitRow[], links: Referral[], apptSource: Map<string, string>) {
  const ids = new Set(visits.map((v) => v.id));
  const parent = new Map(visits.map((v) => [v.id, v.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));

  // Which visit did each referral lead to? The referral's own link (set at check-in), else the booking made from it.
  const visitByOrder = new Map<string, string>();
  for (const v of visits) {
    const order = v.appointmentId ? apptSource.get(v.appointmentId) : undefined;
    if (order) visitByOrder.set(order, v.id);
  }
  const ledTo = new Map<string, string>(); // orderId → visitId
  for (const l of links) {
    const to = l.toVisitId ?? visitByOrder.get(l.orderId);
    if (to && ids.has(to)) ledTo.set(l.orderId, to);
    if (to && ids.has(to) && ids.has(l.fromVisitId)) union(l.fromVisitId, to);
  }
  const groups = new Map<string, VisitRow[]>();
  for (const v of visits) {
    const root = find(v.id);
    groups.set(root, [...(groups.get(root) ?? []), v]);
  }
  const byVisit = new Map<string, VisitRow[]>();
  for (const g of groups.values()) {
    g.sort((a, b) => +a.startedAt - +b.startedAt);
    for (const v of g) byVisit.set(v.id, g);
  }
  return { groups: [...groups.values()], byVisit, ledTo };
}

async function people(visits: VisitRow[], extraStaff: string[] = []) {
  const [doctors, patients] = await Promise.all([
    staffService.doctorsByIds([...new Set([...visits.map((v) => v.doctorId), ...extraStaff])]),
    patientsService.summaries(visits.map((v) => v.patientId)),
  ]);
  const doctor = (id: string) => {
    const d = doctors.get(id);
    return d ? { id: d.id, name: d.fullName, specialty: d.specialty, department: d.department?.name ?? null } : { id, name: 'Doctor', specialty: null, department: null };
  };
  const patient = (id: string) => {
    const p = patients.get(id);
    return p ? { id: p.id, name: p.name, mrn: p.mrn } : null;
  };
  return { doctor, patient };
}

const visitHeader = (v: VisitRow, doctor: ReturnType<Awaited<ReturnType<typeof people>>['doctor']>) => ({
  id: v.id, visitNumber: v.visitNumber, type: v.type, status: v.status, startedAt: v.startedAt, endedAt: v.endedAt,
  doctor: { id: doctor.id, name: doctor.name, specialty: doctor.specialty }, department: doctor.department,
});

/** Diagnosis and advice only (the patient-facing part of the note). The visit's own doctor's note first. */
function patientNote(notes: ReturnType<typeof presentNote>[], v: VisitRow) {
  const mine = notes.filter((n) => n.visitId === v.id);
  const n = mine.find((x) => x.authorId === v.doctorId) ?? mine[0];
  return { diagnosis: n?.diagnosis ?? null, advice: n?.advice ?? null };
}

async function household(actor: Actor) {
  return patientsService.accessiblePatientIds(actor.session.userId);
}

export const portalVisitsService = {
  /** "My visits": every visit of the household, grouped by journey (newest journey first, visits in date order). */
  async history(actor: Actor) {
    const patientIds = await household(actor);
    const visits = (await Promise.all(patientIds.map((id) => visitsService.listForPatient(id)))).flat().filter((v) => v.status !== 'CANCELLED');
    const [links, apptSource] = await Promise.all([
      ordersService.referralLinks(patientIds),
      schedulingService.sourceOrders(visits.map((v) => v.appointmentId).filter((x): x is string => !!x)),
    ]);
    const { groups } = journeys(visits, links, apptSource);
    const { doctor, patient } = await people(visits);
    return groups
      .map((g) => ({
        id: g[0]!.id,
        patient: patient(g[0]!.patientId),
        visits: g.map((v) => visitHeader(v, doctor(v.doctorId))),
        lastAt: g[g.length - 1]!.startedAt,
      }))
      .sort((a, b) => +b.lastAt - +a.lastAt);
  },

  /** One visit's patient-facing detail + its journey. 403 (audited) for anyone outside the household. */
  async detail(actor: Actor, visitId: string) {
    const visit = await visitsService.get(visitId);
    const patientIds = await household(actor);
    if (!patientIds.includes(visit.patientId)) {
      await auditService.recordSafe({
        actorId: actor.session.userId, action: AuditAction.ACCESS_DENIED, entity: 'visits', entityId: visit.id, patientId: visit.patientId, ip: actor.ip ?? null,
        metadata: { reason: 'NOT_OWN_VISIT', role: actor.session.role },
      });
      throw AppError.forbidden('You can only view your own visits and your family members’ visits');
    }

    // The journey: this patient's visits joined by referrals.
    const all = (await visitsService.listForPatient(visit.patientId)).filter((v) => v.status !== 'CANCELLED' || v.id === visit.id);
    const [links, apptSource] = await Promise.all([
      ordersService.referralLinks([visit.patientId]),
      schedulingService.sourceOrders(all.map((v) => v.appointmentId).filter((x): x is string => !!x)),
    ]);
    const { byVisit, ledTo } = journeys(all, links, apptSource);
    const chain = byVisit.get(visit.id) ?? [visit];
    const chainIds = chain.map((v) => v.id);

    const [orders, notes, bills] = await Promise.all([
      ordersService.patientFacingForVisits(chainIds),
      visitsService.notesForVisits(chainIds).then((n) => n.map(presentNote)),
      billingService.billSummariesForVisits([visit.id]),
    ]);
    const { doctor, patient } = await people(chain, orders.map((o) => o.orderingDoctor.id));
    const visitById = new Map(chain.map((v) => [v.id, v]));
    const ordersOf = (id: string) => orders.filter((o) => o.visitId === id);
    const referralInto = (id: string) => orders.find((o) => o.type === 'REFERRAL' && ledTo.get(o.id) === id) ?? null;

    const tests = ordersOf(visit.id).filter((o) => o.type === 'LAB' || o.type === 'RADIOLOGY');
    const prescriptions = ordersOf(visit.id).filter((o) => o.type === 'MEDICATION' && 'prescription' in o && o.prescription);
    const referrals = ordersOf(visit.id)
      .filter((o) => o.type === 'REFERRAL' && o.status !== 'CANCELLED')
      .map((o) => {
        const to = ledTo.get(o.id);
        const tv = to ? visitById.get(to) : undefined;
        return { ...o, toVisit: tv ? { ...visitHeader(tv, doctor(tv.doctorId)), ...patientNote(notes, tv) } : null };
      });
    const cameFrom = referralInto(visit.id);

    const steps = chain.map((v) => {
      const via = referralInto(v.id);
      const vo = ordersOf(v.id);
      return {
        ...visitHeader(v, doctor(v.doctorId)),
        ...patientNote(notes, v),
        current: v.id === visit.id,
        via: via && 'referral' in via && via.referral ? { reason: via.referral.reason, fromDoctor: via.orderingDoctor.name } : null,
        results: vo.flatMap((o) => ('results' in o ? o.results.map((r) => ({ title: o.title, summary: r.summary, isAbnormal: r.isAbnormal })) : [])),
        medicines: vo.flatMap((o) => ('prescription' in o && o.prescription ? o.prescription.items.map((i) => [i.medicineName, i.dose, i.frequency].filter(Boolean).join(' ')) : [])),
      };
    });
    // Referrals in the journey that have not led to a visit yet (to be booked / booked).
    const pending = orders
      .filter((o) => o.type === 'REFERRAL' && !ledTo.has(o.id) && o.status !== 'CANCELLED' && o.status !== 'COMPLETED')
      .map((o) => ({ orderId: o.id, status: o.status, fromDoctor: o.orderingDoctor.name, ...('referral' in o && o.referral ? { reason: o.referral.reason, toDepartment: o.referral.toDepartment.name, toDoctor: o.referral.toDoctor?.name ?? null, scheduledFor: o.referral.scheduledFor } : {}) }));

    await auditService.record({
      actorId: actor.session.userId, action: AuditAction.VIEW, entity: 'visits', entityId: visit.id, patientId: visit.patientId, ip: actor.ip ?? null,
      metadata: { basis: 'SELF', visitNumber: visit.visitNumber, journeyVisits: chain.length },
    });

    return {
      visit: { ...visitHeader(visit, doctor(visit.doctorId)), patient: patient(visit.patientId) },
      ...patientNote(notes, visit),
      referredFrom: cameFrom && 'referral' in cameFrom && cameFrom.referral ? { orderId: cameFrom.id, fromDoctor: cameFrom.orderingDoctor.name, fromVisitId: cameFrom.visitId, reason: cameFrom.referral.reason } : null,
      prescriptions,
      tests,
      referrals,
      bill: bills.get(visit.id) ?? null,
      journey: { steps, pending },
    };
  },

  /** Referrals still to be booked (Upcoming). Patient's own record, so the reason is included. */
  async referralsToBook(actor: Actor) {
    const ids = await household(actor);
    const [rows, summaries] = await Promise.all([ordersService.referralsToBookFor(ids), patientsService.summaries(ids)]);
    return rows.map((r) => {
      const p = summaries.get(r.patientId);
      return { ...r, patient: p ? { id: p.id, name: p.name, mrn: p.mrn } : null };
    });
  },
};
