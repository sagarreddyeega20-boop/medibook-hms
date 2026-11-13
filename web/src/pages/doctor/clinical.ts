/** Types and small helpers shared by the doctor workspace pages (shapes returned by /api/visits and /api/orders). */
import { statusLabel } from '../../components';
import { whenLabel } from '../../lib/time';

export interface PatientHeader {
  id: string;
  mrn: string;
  name: string;
  gender: string;
  age: number | null;
  dateOfBirth: string | null;
  phone: string | null;
  allergies: string | null;
  bloodGroup: string | null;
}

export type TimelineType = 'VISIT' | 'NOTE' | 'LAB' | 'RADIOLOGY' | 'RESULT' | 'REFERRAL' | 'PRESCRIPTION';
export interface TimelineEvent {
  id: string;
  type: TimelineType;
  at: string;
  title: string;
  status?: string;
  priority?: string;
  department: string | null;
  doctor: string | null;
  visitId: string;
  lines: [string, string][];
}
export interface TimelineResponse {
  access: 'VISIT' | 'ORDER' | 'BREAK_GLASS';
  override: { reason: string; expiresAt: string } | null;
  patient: PatientHeader;
  counts: Record<TimelineType, number>;
  events: TimelineEvent[];
}

export interface Order {
  id: string;
  orderNumber: string;
  visitId: string;
  type: 'LAB' | 'RADIOLOGY' | 'REFERRAL' | 'MEDICATION';
  status: string;
  priority: string;
  title: string;
  clinicalNotes: string | null;
  scheduledFor: string | null;
  createdAt: string;
  orderingDoctor: { id: string; name: string; department: { name: string } | null };
  targetDoctor: { id: string; name: string } | null;
  targetDepartment: { id: string; code: string; name: string };
  referral: { reason: string } | null;
  prescription: { status: string; notes: string | null; items: { id: string; medicineName: string; dose: string | null; frequency: string | null; durationDays: number | null; instructions: string | null; quantity: number }[] } | null;
}

export interface Note { id: string; complaint: string | null; findings: string | null; diagnosis: string | null; advice: string | null; updatedAt: string }

export interface Consultation {
  access: 'VISIT' | 'ORDER' | 'BREAK_GLASS';
  visit: {
    id: string; visitNumber: string; patientId: string; type: 'OPD' | 'WALK_IN'; status: string; chiefComplaint: string | null; tokenNumber: number | null;
    startedAt: string; consultStartedAt: string | null; endedAt: string | null; doctor: { id: string; name: string; department: { name: string } | null } | null;
  };
  patient: PatientHeader;
  pastVisits: number;
  canEdit: boolean;
  isMine: boolean;
  note: Note | null;
  orders: Order[];
  referral: Order | null;
  charges: { id: string; description: string; totalPaise: number; status: string; department: { name: string } }[];
}

export const TIMELINE_FILTERS: { id: 'ALL' | TimelineType | 'ORDERS'; label: string; types?: TimelineType[] }[] = [
  { id: 'ALL', label: 'All' },
  { id: 'VISIT', label: 'Visits', types: ['VISIT'] },
  { id: 'NOTE', label: 'Notes', types: ['NOTE'] },
  { id: 'ORDERS', label: 'Lab & radiology', types: ['LAB', 'RADIOLOGY'] },
  { id: 'RESULT', label: 'Results', types: ['RESULT'] },
  { id: 'REFERRAL', label: 'Referrals', types: ['REFERRAL'] },
  { id: 'PRESCRIPTION', label: 'Prescriptions', types: ['PRESCRIPTION'] },
];

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
/** Timeline values that are timestamps are shown in hospital time. */
export const showValue = (v: string) => (ISO.test(v) ? whenLabel(v) : v);

/** "Male, 41 · MB-2026-000123" (v1 patient meta line). */
export const patientMeta = (p: Pick<PatientHeader, 'gender' | 'age' | 'mrn'>) =>
  [[p.gender !== 'UNKNOWN' ? statusLabel(p.gender) : null, p.age !== null ? String(p.age) : null].filter(Boolean).join(', '), p.mrn].filter(Boolean).join(' · ');

export const ACCESS_LABELS: Record<Consultation['access'], string> = {
  VISIT: 'You treat this patient',
  ORDER: 'Referred / ordered to you',
  BREAK_GLASS: 'Break-glass access',
};
