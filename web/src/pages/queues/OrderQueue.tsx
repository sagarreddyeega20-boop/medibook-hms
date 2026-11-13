import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Card, DashGrid, EmptyState, Input, NowConsultingCard, PersonCell, PersonList, Segmented, StatCard, StatGrid, Table, Textarea, useToast, type Column,
} from '../../components';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { greeting } from '../../lib/format';
import { useLive } from '../../lib/live';
import { longDayLabel, timeLabel, todayKey, whenLabel } from '../../lib/time';
import { patientMeta } from '../doctor/clinical';
import { StaffLayout } from '../staff/StaffLayout';

type QueueType = 'LAB' | 'RADIOLOGY';
interface QueueItem {
  id: string;
  orderNumber: string;
  status: string;
  priority: 'ROUTINE' | 'URGENT' | 'STAT';
  title: string;
  createdAt: string;
  startedAt: string | null;
  resultReadyAt: string | null;
  department: { name: string };
  patient: { id: string; name: string; mrn: string; gender: string; age: number | null } | null;
  orderingDoctor: { name: string; department: string | null };
  result: { id: string; summary: string | null; isAbnormal: boolean; fileUrl: string | null; reportedAt: string } | null;
}
interface Queue {
  departments: { name: string }[];
  stats: { toCollect: number; inProgress: number; urgent: number; readyToday: number };
  items: QueueItem[];
}

/** Words that differ between the bench and the scanner. */
const COPY: Record<QueueType, { api: string; start: string; started: string; toDo: string; waiting: string; title: string }> = {
  LAB: { api: '/api/orders/lab/dashboard', start: 'Sample collected', started: 'Sample collected', toDo: 'Samples to collect', waiting: 'Lab queue', title: 'Lab' },
  RADIOLOGY: { api: '/api/orders/radiology/dashboard', start: 'Scan done', started: 'Scan done', toDo: 'Scans to do', waiting: 'Radiology queue', title: 'Radiology' },
};

const MAX_BYTES = 5 * 1024 * 1024;
const readAsDataUrl = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

/**
 * LAB_TECH / RADIOLOGY_TECH home: v1 staff dashboard — the department's order queue (patient, MRN, test, ordering doctor,
 * urgency, status), "Sample collected / Scan done", and result upload (findings + optional PDF/image) in the side panel.
 * Technicians never see clinical notes: the queue API carries no doctor notes or indication.
 */
export function OrderQueue({ type }: { type: QueueType }) {
  const { user } = useAuth();
  const toast = useToast();
  const copy = COPY[type];
  const [data, setData] = useState<Queue | null>(null);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => setData(await api<Queue>(copy.api)), [copy.api]);
  useEffect(() => {
    load().catch((err) => toast.error('Could not load the queue', errorMessage(err)));
  }, [load, toast]);
  useLive(['orders:changed'], () => void load().catch(() => undefined));

  const q = search.trim().toLowerCase();
  const match = (i: QueueItem) => !q || [i.patient?.name, i.patient?.mrn, i.title, i.orderNumber, i.orderingDoctor.name].some((s) => s?.toLowerCase().includes(q));
  const pending = useMemo(() => (data?.items ?? []).filter((i) => i.status !== 'RESULT_READY' && match(i)), [data, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = useMemo(() => (data?.items ?? []).filter((i) => i.status === 'RESULT_READY' && match(i)), [data, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const selected = data?.items.find((i) => i.id === selectedId && i.status !== 'RESULT_READY') ?? pending.find((i) => i.status === 'IN_PROGRESS') ?? null;

  const start = async (o: QueueItem) => {
    setBusy(o.id);
    try {
      await api(`/api/orders/${o.id}/start`, { method: 'POST' });
      toast.success(`${copy.started}`, `${o.title} for ${o.patient?.name ?? 'the patient'} — upload the result when it is ready.`);
      setSelectedId(o.id);
      await load();
    } catch (err) {
      toast.error('Could not update the order', errorMessage(err));
      await load().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  const columns: Column<QueueItem>[] = [
    { key: 'patient', header: 'Patient', render: (o) => <PersonCell name={o.patient?.name ?? 'Patient'} sub={o.patient ? patientMeta(o.patient) : undefined} /> },
    { key: 'test', header: 'Test', render: (o) => <PersonCell name={o.title} sub={`${o.orderNumber} · ${timeLabel(o.createdAt)}`} /> },
    { key: 'doctor', header: 'Ordered by', render: (o) => <PersonCell name={o.orderingDoctor.name} sub={o.orderingDoctor.department ?? undefined} /> },
    { key: 'priority', header: 'Urgency', render: (o) => <Badge status={o.priority} /> },
    { key: 'status', header: 'Status', render: (o) => <Badge status={o.status}>{o.status === 'IN_PROGRESS' ? copy.started : undefined}</Badge> },
    {
      key: 'action', header: 'Action',
      render: (o) =>
        o.status === 'IN_PROGRESS' ? (
          <Button size="sm" variant={selected?.id === o.id ? 'primary' : 'secondary'} onClick={() => setSelectedId(o.id)}>Upload result</Button>
        ) : (
          <Button size="sm" loading={busy === o.id} onClick={() => void start(o)}>{copy.start}</Button>
        ),
    },
  ];

  const first = user?.name.split(' ')[0] ?? '';
  const s = data?.stats;
  return (
    <StaffLayout
      title={`${greeting()}, ${first}`}
      subtitle={`${longDayLabel(todayKey())} · ${data?.departments.map((d) => d.name).join(', ') ?? copy.title}`}
      search={{ placeholder: 'Search patient, MRN or test', value: search, onChange: setSearch }}
    >
      <StatGrid label="Queue at a glance">
        <StatCard label={copy.toDo} value={s?.toCollect ?? '—'} />
        <StatCard label="In progress" value={s?.inProgress ?? '—'} tone="blue" />
        <StatCard label="Urgent / STAT waiting" value={s?.urgent ?? '—'} tone="danger" />
        <StatCard label="Results today" value={s?.readyToday ?? '—'} tone="teal" />
      </StatGrid>

      <DashGrid
        main={
          <Card flush>
            <div className="mb-card__head" style={{ padding: 'var(--space-5) var(--space-6) 0' }}>
              <h2 className="mb-card__title">{copy.waiting}</h2>
              <Badge tone="success" dot size="sm">Live</Badge>
            </div>
            <Table
              columns={columns}
              rows={pending}
              rowKey={(o) => o.id}
              isCurrent={(o) => o.id === selected?.id}
              caption={copy.waiting}
              empty={<EmptyState title={data ? (q ? 'No order matches your search' : 'The queue is clear') : 'Loading…'} text={data && !q ? 'New orders from doctors appear here the moment they are placed.' : undefined} />}
            />
          </Card>
        }
        side={
          <>
            {selected ? (
              <ResultForm key={selected.id} order={selected} type={type} onDone={async () => { setSelectedId(null); await load(); }} />
            ) : (
              <NowConsultingCard title="Result entry" emptyText={`Mark an order “${copy.start}”, then upload its result here.`} />
            )}
            <Card title="Results today" subtitle="On the patient’s timeline; the ordering doctor was notified.">
              {done.length ? (
                <PersonList
                  items={done.map((o) => ({
                    key: o.id,
                    name: <>{o.result?.isAbnormal && <Badge status="ABNORMAL" size="sm" />} {o.title}</>,
                    sub: `${o.patient?.name ?? 'Patient'} · ${o.patient?.mrn ?? ''}${o.resultReadyAt ? ` · ${whenLabel(o.resultReadyAt)}` : ''}`,
                    action: o.result?.fileUrl ? <a className="mb-btn mb-btn--link" href={o.result.fileUrl} target="_blank" rel="noreferrer">Report</a> : <Badge status="RESULT_READY" size="sm" />,
                  }))}
                />
              ) : (
                <p className="muted">{data ? 'No results uploaded today.' : 'Loading…'}</p>
              )}
            </Card>
          </>
        }
      />
    </StaffLayout>
  );
}

/** Side-panel form: findings + Normal/Abnormal + optional PDF/image → RESULT_READY. */
function ResultForm({ order, type, onDone }: { order: QueueItem; type: QueueType; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [summary, setSummary] = useState('');
  const [flag, setFlag] = useState<'NORMAL' | 'ABNORMAL'>('NORMAL');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const pick = (f: File | null) => {
    setFileError(undefined);
    if (f && f.size > MAX_BYTES) return setFileError('The file is larger than 5 MB'), setFile(null);
    if (f && !/^(application\/pdf|image\/(png|jpeg|webp))$/.test(f.type)) return setFileError('Choose a PDF, PNG, JPEG or WebP file'), setFile(null);
    setFile(f);
  };

  const submit = async () => {
    setBusy(true);
    try {
      const payload = { summary, isAbnormal: flag === 'ABNORMAL', file: file ? { name: file.name, base64: await readAsDataUrl(file) } : null };
      await api(`/api/orders/${order.id}/result`, { json: payload });
      toast.success('Result uploaded', `${order.title} is on ${order.patient?.name ?? 'the patient'}’s timeline and ${order.orderingDoctor.name} has been notified.`);
      await onDone();
    } catch (err) {
      toast.error('Could not upload the result', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <NowConsultingCard
      title="Upload result"
      patient={order.patient ? { name: order.patient.name, meta: patientMeta(order.patient), status: order.priority !== 'ROUTINE' ? order.priority : undefined } : undefined}
      facts={[order.orderNumber, order.startedAt ? `${type === 'LAB' ? 'Sample' : 'Scan'} ${timeLabel(order.startedAt)}` : ''].filter(Boolean)}
      intakeLabel={type === 'LAB' ? 'Test' : 'Scan'}
      intake={`${order.title} · ordered by ${order.orderingDoctor.name}`}
    >
      <div className="stack">
        <Textarea label="Findings" rows={5} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder={type === 'LAB' ? 'e.g. Sinus rhythm, rate 82/min. No ST–T changes.' : 'e.g. Lung fields clear. Cardiac silhouette normal.'} />
        <Segmented label="Result flag" value={flag} onChange={(v) => setFlag(v as 'NORMAL' | 'ABNORMAL')} options={[{ id: 'NORMAL', label: 'Normal' }, { id: 'ABNORMAL', label: 'Abnormal' }]} />
        <Input label="Report file (optional)" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => pick(e.target.files?.[0] ?? null)} error={fileError} hint="PDF or image, up to 5 MB. Only the care team can open it." />
        <Button block loading={busy} disabled={summary.trim().length < 3 || !!fileError} onClick={() => void submit()}>Upload result</Button>
      </div>
    </NowConsultingCard>
  );
}
