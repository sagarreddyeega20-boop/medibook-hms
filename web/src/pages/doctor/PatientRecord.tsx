import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Card, DashGrid } from '../../components';
import { StaffLayout } from '../staff/StaffLayout';
import { patientMeta, type TimelineResponse } from './clinical';
import { BreakGlassCard, PatientHeaderCard, PatientTimelineCard } from './PatientTimeline';

/**
 * A patient's full record for a doctor (header + cross-department timeline). The server decides access: treating,
 * referred-to or ordered-to doctors get in; anyone else gets the break-glass card.
 */
export function PatientRecord() {
  const { patientId = '' } = useParams();
  const navigate = useNavigate();
  const [record, setRecord] = useState<TimelineResponse | null>(null);
  const [denied, setDenied] = useState(false);
  const [refresh, setRefresh] = useState(0);

  const p = record?.patient;
  return (
    <StaffLayout
      title={p ? p.name : 'Patient record'}
      subtitle={p ? `${patientMeta(p)} · full timeline across departments` : 'Access is checked and every view is audited.'}
      actions={<Button variant="secondary" onClick={() => navigate('/doctor')}>Back to schedule</Button>}
    >
      {denied ? (
        <DashGrid
          main={<BreakGlassCard patientId={patientId} onGranted={() => { setDenied(false); setRefresh((n) => n + 1); }} />}
          side={
            <Card title="Why am I seeing this?">
              <p className="muted">Doctors can open a record only when they have a visit with the patient, or an order or referral addressed to them. This keeps records private; break-glass exists for emergencies.</p>
            </Card>
          }
        />
      ) : (
        <DashGrid
          main={<PatientTimelineCard patientId={patientId} refreshKey={refresh} onLoaded={(r) => setRecord(r)} onDenied={() => { setRecord(null); setDenied(true); }} />}
          side={p ? <PatientHeaderCard patient={p} access={record!.access} overrideUntil={record!.override?.expiresAt} /> : <Card><p className="muted">Loading…</p></Card>}
        />
      )}
    </StaffLayout>
  );
}
