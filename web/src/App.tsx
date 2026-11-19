import { Route, Routes } from 'react-router-dom';
import { AccountsHome } from './pages/accounts/AccountsHome';
import { AuditLog } from './pages/admin/AuditLog';
import { PriceList } from './pages/admin/PriceList';
import { BillingCounter } from './pages/billing/BillingCounter';
import { CloseDay } from './pages/billing/CloseDay';
import { PatientBill } from './pages/billing/PatientBill';
import { Departments } from './pages/admin/Departments';
import { Doctors } from './pages/admin/Doctors';
import { StaffRoles } from './pages/admin/StaffRoles';
import { Login } from './pages/auth/Login';
import { Register } from './pages/auth/Register';
import { SetPassword } from './pages/auth/SetPassword';
import { ComponentsDemo } from './pages/ComponentsDemo';
import { MobileChatDemo } from './pages/demo/MobileChatDemo';
import { PatientAppointmentsDemo } from './pages/demo/PatientAppointmentsDemo';
import { PatientHomeDemo } from './pages/demo/PatientHomeDemo';
import { PaymentDemo } from './pages/demo/PaymentDemo';
import { StaffDashboardDemo } from './pages/demo/StaffDashboardDemo';
import { Consultation } from './pages/doctor/Consultation';
import { DoctorHome } from './pages/doctor/DoctorHome';
import { PatientRecord } from './pages/doctor/PatientRecord';
import { Home } from './pages/Home';
import { NotFound } from './pages/NotFound';
import { FindDoctor } from './pages/patient/FindDoctor';
import { MyAppointments } from './pages/patient/MyAppointments';
import { MyBills } from './pages/patient/MyBills';
import { PayBooking } from './pages/patient/PayBooking';
import { PatientHome } from './pages/patient/PatientHome';
import { VisitDetail } from './pages/patient/VisitDetail';
import { Dispense } from './pages/pharmacy/Dispense';
import { PharmacyHome } from './pages/pharmacy/PharmacyHome';
import { PharmacyStock } from './pages/pharmacy/PharmacyStock';
import { OrderQueue } from './pages/queues/OrderQueue';
import { Patients } from './pages/reception/Patients';
import { ReceptionBoard } from './pages/reception/ReceptionBoard';
import { RoleHome } from './pages/staff/RoleHome';
import { RequireAuth, RootRedirect } from './lib/auth';
import type { Role } from './lib/roles';

const ADMINS: Role[] = ['SUPER_ADMIN', 'ADMIN'];
const COUNTER: Role[] = ['RECEPTIONIST', 'ACCOUNTS'];
const guard = (roles: Role[], el: JSX.Element) => <RequireAuth roles={roles}>{el}</RequireAuth>;

export function App() {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />

      {/* Public: login (Staff | Patient), patient sign-up, staff set-password link */}
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/set-password" element={<SetPassword />} />

      {/* Admin console home; every other role has its own home page below */}
      <Route path="/admin" element={guard(ADMINS, <RoleHome />)} />
      <Route path="/admin/staff" element={guard(ADMINS, <StaffRoles />)} />
      <Route path="/admin/audit" element={guard(ADMINS, <AuditLog />)} />
      <Route path="/admin/departments" element={guard(ADMINS, <Departments />)} />
      <Route path="/admin/doctors" element={guard(ADMINS, <Doctors />)} />
      <Route path="/admin/prices" element={guard(ADMINS, <PriceList />)} />
      <Route path="/reception" element={guard(['RECEPTIONIST'], <ReceptionBoard />)} />
      <Route path="/reception/patients" element={guard(['RECEPTIONIST'], <Patients />)} />
      <Route path="/doctor" element={guard(['DOCTOR'], <DoctorHome />)} />
      <Route path="/doctor/visits/:visitId" element={guard(['DOCTOR'], <Consultation />)} />
      <Route path="/doctor/patients/:patientId" element={guard(['DOCTOR'], <PatientRecord />)} />
      <Route path="/lab" element={guard(['LAB_TECH'], <OrderQueue key="LAB" type="LAB" />)} />
      <Route path="/radiology" element={guard(['RADIOLOGY_TECH'], <OrderQueue key="RADIOLOGY" type="RADIOLOGY" />)} />
      <Route path="/pharmacy" element={guard(['PHARMACIST'], <PharmacyHome />)} />
      <Route path="/pharmacy/dispense/:id" element={guard(['PHARMACIST'], <Dispense />)} />
      <Route path="/pharmacy/stock" element={guard(['PHARMACIST'], <PharmacyStock />)} />
      <Route path="/billing" element={guard(COUNTER, <BillingCounter />)} />
      <Route path="/billing/patients/:patientId" element={guard(COUNTER, <PatientBill />)} />
      <Route path="/billing/close-day" element={guard(COUNTER, <CloseDay />)} />
      <Route path="/accounts" element={guard(['ACCOUNTS'], <AccountsHome />)} />
      <Route path="/patient" element={guard(['PATIENT'], <PatientHome />)} />
      <Route path="/patient/doctors" element={guard(['PATIENT'], <FindDoctor />)} />
      <Route path="/patient/appointments" element={guard(['PATIENT'], <MyAppointments />)} />
      <Route path="/patient/bills" element={guard(['PATIENT'], <MyBills />)} />
      <Route path="/patient/visits/:id" element={guard(['PATIENT'], <VisitDetail />)} />
      <Route path="/patient/pay" element={guard(['PATIENT'], <PayBooking />)} />

      {/* Developer reference: foundation overview + v1 pattern demos */}
      <Route path="/demo" element={<Home />} />
      <Route path="/demo/components" element={<ComponentsDemo />} />
      <Route path="/demo/staff" element={<StaffDashboardDemo />} />
      <Route path="/demo/patient" element={<PatientHomeDemo />} />
      <Route path="/demo/patient/appointments" element={<PatientAppointmentsDemo />} />
      <Route path="/demo/patient/payment" element={<PaymentDemo />} />
      <Route path="/demo/patient/chat" element={<MobileChatDemo />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
