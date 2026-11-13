import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Badge, Button, Card, DashGrid, EmptyState, Input, Modal, PersonCell, PersonList, StatCard, StatGrid, Table, useToast, type Column,
} from '../../components';
import { api, errorMessage } from '../../lib/api';
import { useLive } from '../../lib/live';
import { whenLabel } from '../../lib/time';
import { StaffLayout } from '../staff/StaffLayout';
import { PatientPicker, patientLine, RegisterPatientForm, usePatientSearch, type PatientSummary } from './PatientPicker';

interface FamilyLink { linkId: string; relationship: string; patient: PatientSummary }
interface PatientDetail extends PatientSummary {
  address: string | null;
  familyMembers: FamilyLink[];
  accountHolders: FamilyLink[];
}
interface Appointment {
  id: string;
  ref: string;
  status: string;
  slotStart: string;
  doctor: { name: string; department: { name: string } | null } | null;
  cancelReason: string | null;
}

/** Reception: find patients by MRN, name or phone; register (duplicate check); link family members. */
export function Patients() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const results = usePatientSearch(q);
  const [selectedId, setSelectedId] = useState<string | null>(params.get('id'));
  const [detail, setDetail] = useState<PatientDetail | null>(null);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [registering, setRegistering] = useState(false);
  const [linking, setLinking] = useState(false);
  const [member, setMember] = useState<PatientSummary | null>(null);
  const [relationship, setRelationship] = useState('');
  const [busy, setBusy] = useState(false);

  const loadDetail = useCallback(async (id: string) => {
    const [d, a] = await Promise.all([
      api<{ patient: PatientDetail }>(`/api/patients/${id}`),
      api<{ appointments: Appointment[] }>(`/api/scheduling/appointments?patientId=${id}`),
    ]);
    setDetail(d.patient);
    setAppointments(a.appointments);
  }, []);

  useEffect(() => {
    if (!selectedId) return setDetail(null);
    loadDetail(selectedId).catch((err) => toast.error('Could not open the patient', errorMessage(err)));
  }, [selectedId, loadDetail, toast]);
  useLive(['board:changed'], () => selectedId && void loadDetail(selectedId).catch(() => undefined), !!selectedId);

  const open = (p: PatientSummary) => {
    setSelectedId(p.id);
    setParams({ ...(q ? { q } : {}), id: p.id });
  };

  const link = async () => {
    if (!detail || !member) return;
    setBusy(true);
    try {
      await api(`/api/patients/${detail.id}/family`, { json: { memberPatientId: member.id, relationship } });
      setLinking(false);
      setMember(null);
      setRelationship('');
      await loadDetail(detail.id);
      toast.success('Family member linked', `${member.name} can now be booked from ${detail.name}’s account.`);
    } catch (err) {
      toast.error('Could not link', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (l: FamilyLink) => {
    if (!detail) return;
    try {
      await api(`/api/patients/${detail.id}/family/${l.linkId}`, { method: 'DELETE' });
      await loadDetail(detail.id);
    } catch (err) {
      toast.error('Could not unlink', errorMessage(err));
    }
  };

  const columns: Column<PatientSummary>[] = [
    { key: 'who', header: 'Patient', render: (p) => <PersonCell name={p.name} sub={p.mrn} /> },
    { key: 'dob', header: 'Date of birth', render: (p) => p.dateOfBirth ?? '—' },
    { key: 'phone', header: 'Phone', render: (p) => p.phone ?? '—' },
    { key: 'portal', header: 'Portal', render: (p) => (p.hasPortalAccount ? <Badge tone="info" size="sm">Online account</Badge> : <span className="muted">—</span>) },
  ];

  const upcoming = appointments.filter((a) => a.status === 'BOOKED' || a.status === 'CHECKED_IN');
  return (
    <StaffLayout
      title="Patients"
      subtitle="Search by MRN, name or phone. Registering warns when name, date of birth and phone match someone already here."
      search={{ placeholder: 'Search MRN, name or phone', value: q, onChange: setQ }}
      actions={<Button onClick={() => setRegistering(true)}>Register patient</Button>}
    >
      <StatGrid label="Search">
        <StatCard label="Matches" value={results?.length ?? '—'} />
        <StatCard label="Selected" value={detail?.mrn ?? '—'} tone="teal" />
        <StatCard label="Upcoming visits" value={detail ? upcoming.length : '—'} tone="blue" />
        <StatCard label="Family on account" value={detail ? detail.familyMembers.length : '—'} tone="danger" />
      </StatGrid>
      <DashGrid
        main={
          <Card title="Search results" flush>
            {results === null ? (
              <EmptyState title="Search for a patient" text="Type at least 2 characters of an MRN (MB-2026-…), a name or a phone number." />
            ) : (
              <Table columns={columns} rows={results} rowKey={(p) => p.id} onRowClick={open} isCurrent={(p) => p.id === selectedId}
                empty={<EmptyState title="No match" text="Check the spelling, or register the patient." action={<Button onClick={() => setRegistering(true)}>Register patient</Button>} />} />
            )}
          </Card>
        }
        side={
          detail ? (
            <>
              <Card title={detail.name} subtitle={patientLine(detail)}>
                <dl className="mb-rows mb-rows--compact">
                  <div><dt>Patient ID</dt><dd>{detail.mrn}</dd></div>
                  <div><dt>Email</dt><dd>{detail.email ?? '—'}</dd></div>
                  <div><dt>Portal account</dt><dd>{detail.hasPortalAccount ? 'Yes' : 'No'}</dd></div>
                </dl>
              </Card>
              <Card title="Appointments" subtitle={`${upcoming.length} upcoming`}>
                {appointments.length ? (
                  <PersonList items={appointments.slice(0, 6).map((a) => ({ key: a.id, name: `${a.ref} · ${a.doctor?.name ?? ''}`, sub: whenLabel(a.slotStart), action: <Badge status={a.status} size="sm" /> }))} />
                ) : <p className="muted">No appointments yet. Book from the live board.</p>}
              </Card>
              <Card title="Family" actions={<Button variant="link" onClick={() => setLinking(true)}>Link member</Button>}>
                {detail.familyMembers.length || detail.accountHolders.length ? (
                  <PersonList
                    items={[
                      ...detail.familyMembers.map((f) => ({ key: f.linkId, name: f.patient.name, sub: `${f.relationship} · ${f.patient.mrn}`, action: <Button variant="link" onClick={() => void unlink(f)}>Unlink</Button> })),
                      ...detail.accountHolders.map((f) => ({ key: f.linkId, name: f.patient.name, sub: `Account holder (this patient is their ${f.relationship.toLowerCase()})`, action: <Button variant="link" onClick={() => open(f.patient)}>Open</Button> })),
                    ]}
                  />
                ) : <p className="muted">One account can book for several family members (children, parents).</p>}
              </Card>
            </>
          ) : (
            <Card title="Patient"><p className="muted">Select a patient to see contact details, appointments and family.</p></Card>
          )
        }
      />

      <Modal open={registering} title="Register patient" onClose={() => setRegistering(false)}>
        <RegisterPatientForm initialName={/\d/.test(q) ? '' : q} onDone={(p) => { setRegistering(false); open(p); toast.success(`${p.name} · ${p.mrn}`, 'Patient record ready.'); }} />
      </Modal>

      <Modal
        open={linking}
        title={`Link a family member to ${detail?.name ?? ''}`}
        onClose={() => setLinking(false)}
        footer={<><Button variant="secondary" onClick={() => setLinking(false)}>Cancel</Button><Button loading={busy} disabled={!member || relationship.trim().length < 2} onClick={link}>Link</Button></>}
      >
        <div className="stack">
          <PatientPicker selected={member} onPick={setMember} />
          <Input label="Relationship to the account holder" placeholder="e.g. Mother, Son" value={relationship} onChange={(e) => setRelationship(e.target.value)} />
        </div>
      </Modal>
    </StaffLayout>
  );
}
