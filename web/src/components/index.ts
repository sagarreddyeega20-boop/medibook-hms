import './components.css';
import './patterns.css';

/* Base components */
export { Badge, STATUS_LABELS, STATUS_TONES, statusLabel, type BadgeTone } from './Badge';
export { Button, type ButtonVariant } from './Button';
export { Card } from './Card';
export { EmptyState } from './EmptyState';
export { Field, Input, Textarea } from './Input';
export { Icon, LogoTile, type IconName } from './Icon';
export { Modal } from './Modal';
export { Select, type SelectOption } from './Select';
export { PersonCell, Table, type Column } from './Table';
export { Tabs, type TabItem } from './Tabs';
export { ToastProvider, useToast, type ToastTone } from './Toast';

/* Layouts (see "UI rules" in CLAUDE.md) */
export { AppShell, DashGrid, type NavItem, type NavSection } from './AppShell';
export { PatientGrid, PatientLayout, PatientNavbar, type NavbarLink } from './PatientLayout';

/* v1 page patterns */
export { AvailabilityChips, NowConsultingCard, StatCard, StatGrid, type DayAvailability, type StatTone } from './Dashboard';
export { AppointmentCard, DateTile, HeroBanner, PersonList, Pill, SideCard } from './PatientCards';
export { ChatAppointment, ChatBlock, ChatMessage, ChatPanel, ConfirmationCard, DoctorSlotCard, QuickReplies, SlotChip, TypingIndicator } from './Chat';
export { AuthCard, AuthNote, IdHighlight, OtpInput, Segmented, type SegmentOption } from './Auth';
export { DoctorBoardCard, SLOT_STATE_LABELS, SlotGrid, SlotLegend, type SlotCell, type SlotGridState } from './Booking';
export { DOCTOR_DOT_TONES, StatusDot, doctorStatusRank, type DotTone } from './StatusDot';
export { DoctorStatusSelect, doctorStatusText, sortByDoctorStatus, type DoctorStatusOption } from './DoctorStatusSelect';
export { Timeline, type TimelineEntry } from './Timeline';
export { OptionTiles, OrDivider, OrderSummary, PaymentMethodCard, ResultCard, SummaryRows, TrustNote } from './Payment';
export { HBarChart, TrendChart } from './Charts';
