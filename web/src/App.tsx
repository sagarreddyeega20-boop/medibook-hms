import { Route, Routes } from 'react-router-dom';
import { ComponentsDemo } from './pages/ComponentsDemo';
import { MobileChatDemo } from './pages/demo/MobileChatDemo';
import { PatientAppointmentsDemo } from './pages/demo/PatientAppointmentsDemo';
import { PatientHomeDemo } from './pages/demo/PatientHomeDemo';
import { PaymentDemo } from './pages/demo/PaymentDemo';
import { StaffDashboardDemo } from './pages/demo/StaffDashboardDemo';
import { Home } from './pages/Home';
import { NotFound } from './pages/NotFound';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/demo/components" element={<ComponentsDemo />} />
      {/* v1 pattern demos — reference implementations for every new screen */}
      <Route path="/demo/staff" element={<StaffDashboardDemo />} />
      <Route path="/demo/patient" element={<PatientHomeDemo />} />
      <Route path="/demo/patient/appointments" element={<PatientAppointmentsDemo />} />
      <Route path="/demo/patient/payment" element={<PaymentDemo />} />
      <Route path="/demo/patient/chat" element={<MobileChatDemo />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
