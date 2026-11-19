/** Patient portal: own (and family) visits, visit detail with its journey, referrals still to book. */
import { api } from './api';

export interface VisitHeader {
  id: string;
  visitNumber: string;
  type: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  doctor: { id: string; name: string; specialty: string | null };
  department: string | null;
}

export interface VisitJourney {
  id: string;
  patient: { id: string; name: string; mrn: string } | null;
  visits: VisitHeader[];
}

export interface ReferralToBook {
  orderId: string;
  orderNumber: string;
  patientId: string;
  fromVisitId: string;
  priority: string;
  createdAt: string;
  reason: string | null;
  fromDoctor: { id: string; name: string; department: string | null };
  toDepartment: { id: string; code: string; name: string };
  toDoctor: { id: string; name: string } | null;
  patient: { id: string; name: string; mrn: string } | null;
}

interface OrderBase { id: string; orderNumber: string; visitId: string; type: string; status: string; title: string; createdAt: string; department: string; orderingDoctor: { id: string; name: string } }
export interface TestOrder extends OrderBase {
  results: { id: string; summary: string | null; values: unknown; isAbnormal: boolean; fileUrl: string | null; reportedAt: string }[];
}
export interface PrescriptionOrder extends OrderBase {
  prescription: {
    id: string;
    status: string;
    items: { id: string; medicineName: string; dose: string | null; frequency: string | null; durationDays: number | null; route: string | null; instructions: string | null; quantity: number; dispensedQuantity: number; dispensed: boolean }[];
  };
}
export interface ReferralOrder extends OrderBase {
  referral: { reason: string | null; toDepartment: { id: string; name: string }; toDoctor: { id: string; name: string } | null; toVisitId: string | null; scheduledFor: string | null };
  toVisit: (VisitHeader & { diagnosis: string | null; advice: string | null }) | null;
}

export interface JourneyStep extends VisitHeader {
  diagnosis: string | null;
  advice: string | null;
  current: boolean;
  via: { reason: string | null; fromDoctor: string } | null;
  results: { title: string; summary: string | null; isAbnormal: boolean }[];
  medicines: string[];
}

export interface VisitDetail {
  visit: VisitHeader & { patient: { id: string; name: string; mrn: string } | null };
  diagnosis: string | null;
  advice: string | null;
  referredFrom: { orderId: string; fromDoctor: string; fromVisitId: string; reason: string | null } | null;
  prescriptions: PrescriptionOrder[];
  tests: TestOrder[];
  referrals: ReferralOrder[];
  bill: { invoiceId: string; invoiceNumber: string; status: string; totalPaise: number; paidPaise: number; balancePaise: number } | null;
  journey: {
    steps: JourneyStep[];
    pending: { orderId: string; status: string; fromDoctor: string; reason?: string | null; toDepartment?: string; toDoctor?: string | null; scheduledFor?: string | null }[];
  };
}

export const visitsApi = {
  history: () => api<{ journeys: VisitJourney[] }>('/api/visits/mine').then((r) => r.journeys),
  detail: (id: string) => api<VisitDetail>(`/api/visits/mine/${id}`),
  referralsToBook: () => api<{ referrals: ReferralToBook[] }>('/api/visits/mine/referrals').then((r) => r.referrals),
};
