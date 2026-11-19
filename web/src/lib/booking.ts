/**
 * The booking API used by every patient-side screen AND the chatbot — the same endpoints reception uses,
 * so Redis holds and the double-booking constraint apply everywhere.
 */
import { api } from './api';

export interface Department { id: string; code: string; name: string; doctorCount: number }
export interface DirectoryDoctor {
  id: string;
  name: string;
  specialty: string | null;
  department: { id: string; code: string; name: string };
  consultationFeePaise: number | null;
  nextFreeSlot: { start: string; end: string } | null;
}
export interface PortalSlot { start: string; end: string; state: string; past: boolean; bookable: boolean; heldByMe?: boolean }
export interface Hold { holdId: string; doctorId: string; slotStart: string; slotEnd: string; expiresAt: string; holdSeconds: number }
export interface Appointment {
  id: string;
  ref: string;
  status: string;
  source: string;
  slotStart: string;
  slotEnd: string;
  reason: string | null;
  cancelReason: string | null;
  tokenNumber: number | null;
  rescheduledFromId: string | null;
  /** The REFERRAL order this booking fulfils, and who referred. */
  sourceOrderId?: string | null;
  referredBy?: { id: string; name: string; department: string | null } | null;
  /** How the consultation is paid: prepaid online, refunded after a cancel, or at the hospital counter. */
  payment?: 'PAID_ONLINE' | 'REFUNDED' | 'PAY_AT_HOSPITAL';
  patient: { id: string; name: string; mrn: string } | null;
  doctor: { id: string; name: string; specialty: string | null; department: { name: string } | null; consultationFeePaise: number | null } | null;
}
export interface HouseholdMember {
  linkId: string | null;
  relationship: string;
  patient: { id: string; mrn: string; name: string; dateOfBirth: string | null; gender: string };
}

export const bookingApi = {
  departments: () => api<{ departments: Department[] }>('/api/scheduling/departments').then((r) => r.departments.filter((d) => d.doctorCount > 0)),
  doctors: (departmentId?: string, from?: string) => {
    const qs = new URLSearchParams({ ...(departmentId ? { departmentId } : {}), ...(from ? { from } : {}) });
    return api<{ doctors: DirectoryDoctor[] }>(`/api/scheduling/doctors?${qs}`).then((r) => r.doctors);
  },
  slots: (doctorId: string, date: string) => api<{ slots: PortalSlot[]; onLeave: boolean }>(`/api/scheduling/doctors/${doctorId}/slots?date=${date}`),
  hold: (doctorId: string, slotStart: string) => api<{ hold: Hold }>('/api/scheduling/holds', { json: { doctorId, slotStart } }).then((r) => r.hold),
  release: (holdId: string) => api(`/api/scheduling/holds/${holdId}`, { method: 'DELETE' }).catch(() => undefined),
  book: (holdId: string, patientId: string, reason?: string, referralOrderId?: string) =>
    api<{ appointment: Appointment }>('/api/scheduling/appointments', { json: { holdId, patientId, reason: reason || undefined, referralOrderId: referralOrderId || undefined } }).then((r) => r.appointment),
  reschedule: (appointmentId: string, holdId: string) =>
    api<{ appointment: Appointment }>(`/api/scheduling/appointments/${appointmentId}/reschedule`, { json: { holdId } }).then((r) => r.appointment),
  cancel: (appointmentId: string, reason: string) =>
    api<{ appointment: Appointment }>(`/api/scheduling/appointments/${appointmentId}/cancel`, { json: { reason } }).then((r) => r.appointment),
  mine: () => api<{ appointments: Appointment[] }>('/api/scheduling/appointments/mine').then((r) => r.appointments),
  byRef: (ref: string) => api<{ appointment: Appointment }>(`/api/scheduling/appointments/by-ref/${encodeURIComponent(ref)}`).then((r) => r.appointment),
  household: () => api<{ household: HouseholdMember[] }>('/api/patients/me/family').then((r) => r.household),
};

export const isUpcoming = (a: Appointment) => (a.status === 'BOOKED' || a.status === 'CHECKED_IN' || a.status === 'IN_CONSULTATION') && new Date(a.slotEnd).getTime() > Date.now() - 6 * 3600_000;
