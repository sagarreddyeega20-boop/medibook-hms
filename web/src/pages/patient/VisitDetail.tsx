import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Badge, Button, Card, EmptyState, PatientGrid, SideCard, SummaryRows, Table, Timeline, type Column, type TimelineEntry,
} from '../../components';
import { errorMessage } from '../../lib/api';
import { formatPaise } from '../../lib/format';
import { dayLabel, keyOf, whenLabel } from '../../lib/time';
import { visitsApi, type JourneyStep, type PrescriptionOrder, type VisitDetail as Detail } from '../../lib/visits';
import { PatientShell } from './PatientShell';

type RxItem = PrescriptionOrder['prescription']['items'][number];

const rxColumns: Column<RxItem>[] = [
  { key: 'med', header: 'Medicine', render: (i) => <strong>{i.medicineName}</strong> },
  { key: 'dose', header: 'Dose', render: (i) => i.dose ?? '—' },
  { key: 'freq', header: 'Frequency', render: (i) => i.frequency ?? '—' },
  { key: 'days', header: 'Days', numeric: true, render: (i) => i.durationDays ?? '—' },
  { key: 'how', header: 'Instructions', render: (i) => i.instructions ?? '—' },
  { key: 'disp', header: 'Pharmacy', render: (i) => <Badge size="sm" status={i.dispensed ? 'DISPENSED' : i.dispensedQuantity > 0 ? 'PARTIALLY_DISPENSED' : 'NOT_DISPENSED'} /> },
];

/** Structured result values, e.g. [{ name, value, unit, range, flag }]. */
function resultValues(values: unknown): { label: string; value: ReactNode }[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && 'name' in v)
    .map((v) => ({ label: String(v.name), value: [v.value, v.unit].filter(Boolean).join(' ') + (v.range ? ` (${String(v.range)})` : '') + (v.flag ? ` · ${String(v.flag)}` : '') }));
}

function journeyEntries(steps: JourneyStep[], pending: Detail['journey']['pending']): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const s of steps) {
    if (s.via) {
      out.push({ id: `via:${s.id}`, type: 'REFERRAL', title: `Referred by ${s.via.fromDoctor}`, lines: s.via.reason ? [{ label: 'Reason', value: s.via.reason }] : [] });
    }
    out.push({
      id: s.id,
      type: 'VISIT',
      current: s.current,
      title: s.current ? `${s.doctor.name}${s.department ? ` · ${s.department}` : ''} (this visit)` : <Link to={`/patient/visits/${s.id}`}>{s.doctor.name}{s.department ? ` · ${s.department}` : ''}</Link>,
      meta: `${whenLabel(s.startedAt)} · Visit ${s.visitNumber}`,
      status: s.status,
      lines: [
        ...(s.diagnosis ? [{ label: 'Diagnosis', value: s.diagnosis }] : []),
        ...(s.advice ? [{ label: s.via ? 'Concluded' : 'Advice', value: s.advice }] : []),
        ...s.results.map((r) => ({ label: r.title, value: <>{r.summary ?? 'Result ready'}{r.isAbnormal && <> <Badge size="sm" status="ABNORMAL" /></>}</> })),
        ...(s.medicines.length ? [{ label: 'Prescribed', value: s.medicines.join(', ') }] : []),
      ],
    });
  }
  for (const p of pending) {
    out.push({
      id: `pending:${p.orderId}`,
      type: 'REFERRAL',
      title: `Referral to ${p.toDepartment ?? 'another department'}${p.toDoctor ? ` (${p.toDoctor})` : ''}`,
      meta: `By ${p.fromDoctor}${p.scheduledFor ? ` · booked for ${whenLabel(p.scheduledFor)}` : ''}`,
      status: p.status === 'ORDERED' ? 'TO_BE_BOOKED' : p.status,
      lines: p.reason ? [{ label: 'Reason', value: p.reason }] : [],
    });
  }
  return out;
}

/**
 * Patient portal: one past visit — doctor and department, diagnosis and advice, prescription, tests with results
 * (only once ready), referrals made, the bill — and the Journey of visits connected by referrals.
 */
export function VisitDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    visitsApi.detail(id).then(setData).catch((err) => setError(errorMessage(err)));
  }, [id]);

  if (error || !data) {
    return (
      <PatientShell>
        <PatientGrid main={<Card>{error ? <EmptyState title="We couldn’t open this visit" text={error} action={<Link to="/patient/appointments" className="mb-btn mb-btn--primary">My appointments</Link>} /> : <p className="muted">Loading your visit…</p>}</Card>} />
      </PatientShell>
    );
  }

  const v = data.visit;
  const items = data.prescriptions.flatMap((p) => p.prescription.items);
  const journey = journeyEntries(data.journey.steps, data.journey.pending);

  return (
    <PatientShell>
      <PatientGrid
        main={
          <div className="stack">
            <div>
              <p className="mb-eyebrow"><Link to="/patient/appointments">My appointments</Link> · Visit {v.visitNumber}</p>
              <h1 className="mb-page-title">{v.doctor.name}{v.department ? ` · ${v.department}` : ''}</h1>
              <p className="muted">{whenLabel(v.startedAt)}{v.patient ? ` · ${v.patient.name} (${v.patient.mrn})` : ''}</p>
            </div>

            {data.referredFrom && (
              <Card title="Why you came" subtitle={`Referred by ${data.referredFrom.fromDoctor}`} actions={<Link to={`/patient/visits/${data.referredFrom.fromVisitId}`} className="mb-btn mb-btn--secondary mb-btn--sm">Earlier visit</Link>}>
                <SummaryRows rows={[{ label: 'Reason', value: data.referredFrom.reason ?? '—' }]} />
              </Card>
            )}

            <Card title="Diagnosis and advice">
              {data.diagnosis || data.advice ? (
                <SummaryRows rows={[{ label: 'Diagnosis', value: data.diagnosis ?? '—' }, { label: 'Advice', value: data.advice ?? '—' }]} />
              ) : <p className="muted">Your doctor hasn’t added a diagnosis for this visit.</p>}
            </Card>

            <Card flush title="Prescription" subtitle={items.length ? `${items.length} medicine${items.length === 1 ? '' : 's'}` : undefined}>
              <Table columns={rxColumns} rows={items} rowKey={(i) => i.id} caption="Prescription" empty={<EmptyState title="No medicines prescribed" />} />
            </Card>

            <Card title="Tests and scans">
              {data.tests.length ? (
                <div className="stack">
                  {data.tests.map((t) => (
                    <div key={t.id} className="stack">
                      <div className="row">
                        <Badge size="sm" status={t.type} />
                        <strong>{t.title}</strong>
                        <Badge size="sm" status={t.status} />
                        {t.results.some((r) => r.isAbnormal) && <Badge size="sm" status="ABNORMAL" />}
                      </div>
                      {t.results.length ? t.results.map((r) => (
                        <div key={r.id} className="stack">
                          <SummaryRows rows={[{ label: 'Findings', value: r.summary ?? '—' }, ...resultValues(r.values), { label: 'Reported', value: whenLabel(r.reportedAt) }]} />
                          {r.fileUrl && <div className="row"><a className="mb-btn mb-btn--secondary mb-btn--sm" href={r.fileUrl} download>Download report</a></div>}
                        </div>
                      )) : <p className="muted">{t.status === 'CANCELLED' ? 'This test was cancelled.' : `${t.department} will share the result here once it’s ready.`}</p>}
                    </div>
                  ))}
                </div>
              ) : <p className="muted">No tests were ordered at this visit.</p>}
            </Card>

            <Card title="Referrals">
              {data.referrals.length ? (
                <div className="stack">
                  {data.referrals.map((r) => (
                    <div key={r.id} className="stack">
                      <div className="row">
                        <strong>{r.referral.toDepartment.name}{r.referral.toDoctor ? ` · ${r.referral.toDoctor.name}` : ''}</strong>
                        <Badge size="sm" status={r.status === 'ORDERED' ? 'TO_BE_BOOKED' : r.status} />
                      </div>
                      <SummaryRows rows={[
                        { label: 'Reason', value: r.referral.reason ?? '—' },
                        ...(r.referral.scheduledFor && !r.toVisit ? [{ label: 'Booked for', value: whenLabel(r.referral.scheduledFor) }] : []),
                        ...(r.toVisit ? [
                          { label: 'Seen', value: <Link to={`/patient/visits/${r.toVisit.id}`}>{r.toVisit.doctor.name} · {dayLabel(keyOf(r.toVisit.startedAt))}</Link> },
                          ...(r.toVisit.diagnosis ? [{ label: 'Diagnosis', value: r.toVisit.diagnosis }] : []),
                          ...(r.toVisit.advice ? [{ label: 'Concluded', value: r.toVisit.advice }] : []),
                        ] : []),
                      ]} />
                      {r.status === 'ORDERED' && (
                        <div className="row">
                          <Button size="sm" onClick={() => navigate(`/patient/doctors?${new URLSearchParams({ referral: r.id, department: r.referral.toDepartment.id, ...(r.referral.toDoctor ? { doctor: r.referral.toDoctor.id } : {}) })}`)}>
                            Book now
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : <p className="muted">No referrals were made at this visit.</p>}
            </Card>

            <Card title="Journey" subtitle={data.journey.steps.length > 1 ? `${data.journey.steps.length} visits connected by referrals` : 'Visits connected to this one by referrals appear here'}>
              <Timeline items={journey} label="Journey" />
            </Card>
          </div>
        }
        side={
          <>
            <SideCard title="Bill">
              {data.bill ? (
                <div className="stack">
                  <div className="row"><span className="muted">{data.bill.invoiceNumber}</span><Badge size="sm" status={data.bill.status} /></div>
                  <SummaryRows variant="bill" rows={[
                    { label: 'Total', value: formatPaise(data.bill.totalPaise) },
                    { label: 'Paid', value: formatPaise(data.bill.paidPaise) },
                    { label: 'Balance', value: formatPaise(data.bill.balancePaise) },
                  ]} />
                  <Link to="/patient/bills" className="mb-btn mb-btn--secondary mb-btn--sm">My bills</Link>
                </div>
              ) : <p className="muted">No bill for this visit yet.</p>}
            </SideCard>
            <SideCard title="About this visit">
              <SummaryRows rows={[
                { label: 'Doctor', value: v.doctor.name },
                { label: 'Department', value: v.department ?? '—' },
                { label: 'Date', value: whenLabel(v.startedAt) },
                { label: 'Type', value: <Badge size="sm" status={v.type} /> },
                { label: 'Status', value: <Badge size="sm" status={v.status} /> },
              ]} />
            </SideCard>
          </>
        }
      />
    </PatientShell>
  );
}
