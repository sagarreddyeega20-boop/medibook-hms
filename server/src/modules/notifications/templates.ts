/**
 * Message templates. Each template renders per channel; only EMAIL exists today.
 * Adding SMS/WhatsApp later = add a `sms`/`whatsapp` renderer here and a channel sender in the service.
 */
export interface TemplateData {
  otp: { name?: string; code: string; minutes: number; purpose: 'login' | 'registration' };
  'staff-invite': { name: string; staffCode: string; role: string; link: string; hours: number };
  'account-locked': { name: string; minutes: number };
  'appointment-booked': AppointmentMail;
  'appointment-cancelled': AppointmentMail;
  'appointment-rescheduled': AppointmentMail;
}

export interface AppointmentMail {
  name: string;
  mrn: string;
  ref: string;
  doctor: string;
  department: string;
  when: string; // already formatted in hospital time
  reason?: string;
  previousWhen?: string;
}

export type TemplateName = keyof TemplateData;

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// Email clients ignore external CSS, so the few inline colours here mirror tokens.css (--primary, --text, --muted).
const layout = (body: string) => `<!doctype html><html><body style="margin:0;padding:24px;background:#F1F5F4;font-family:Inter,Segoe UI,Arial,sans-serif;color:#1E293B">
<div style="max-width:480px;margin:0 auto;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:16px;padding:32px">
<p style="margin:0 0 16px;font-weight:800;font-size:18px;color:#0F766E">MediBook</p>${body}
<p style="margin:24px 0 0;font-size:12px;color:#64748B">If you didn't expect this email, you can ignore it.</p></div></body></html>`;

export const emailTemplates: { [K in TemplateName]: (d: TemplateData[K]) => RenderedEmail } = {
  otp: (d) => ({
    subject: `${d.code} is your MediBook verification code`,
    text: `${d.name ? `Hello ${d.name},\n\n` : ''}Your MediBook ${d.purpose} code is ${d.code}. It expires in ${d.minutes} minutes.\nNever share this code with anyone — MediBook staff will never ask for it.`,
    html: layout(`${d.name ? `<p>Hello ${esc(d.name)},</p>` : ''}<p>Your MediBook ${d.purpose} code is</p>
<p style="font-size:30px;font-weight:800;letter-spacing:8px;margin:8px 0;color:#0F172A">${esc(d.code)}</p>
<p>It expires in ${d.minutes} minutes. Never share this code with anyone — MediBook staff will never ask for it.</p>`),
  }),
  'staff-invite': (d) => ({
    subject: 'Set your MediBook HMS password',
    text: `Hello ${d.name},\n\nA MediBook HMS account has been created for you.\nStaff ID: ${d.staffCode}\nRole: ${d.role}\n\nSet your password here (the link expires in ${d.hours} hours):\n${d.link}\n\nAfter that, sign in with your staff ID, password and the code we email you.`,
    html: layout(`<p>Hello ${esc(d.name)},</p><p>A MediBook HMS account has been created for you.</p>
<p><strong>Staff ID:</strong> ${esc(d.staffCode)}<br><strong>Role:</strong> ${esc(d.role)}</p>
<p><a href="${esc(d.link)}" style="display:inline-block;background:#0F766E;color:#FFFFFF;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px">Set your password</a></p>
<p style="font-size:13px;color:#64748B">The link expires in ${d.hours} hours. After that, sign in with your staff ID, password and the code we email you.</p>`),
  }),
  'account-locked': (d) => ({
    subject: 'Your MediBook HMS account was locked',
    text: `Hello ${d.name},\n\nYour account was locked for ${d.minutes} minutes after several wrong password attempts. If this wasn't you, tell your administrator.`,
    html: layout(`<p>Hello ${esc(d.name)},</p><p>Your account was locked for ${d.minutes} minutes after several wrong password attempts. If this wasn't you, tell your administrator.</p>`),
  }),
  'appointment-booked': (d) => appointmentMail(d, 'Appointment confirmed', `Your appointment is confirmed.`),
  'appointment-cancelled': (d) =>
    appointmentMail(d, 'Appointment cancelled', `Your appointment has been cancelled${d.reason ? ` (reason: ${d.reason})` : ''}. You can book a new time on MediBook or at reception.`),
  'appointment-rescheduled': (d) =>
    appointmentMail(d, 'Appointment rescheduled', `Your appointment${d.previousWhen ? ` on ${d.previousWhen}` : ''} has been moved to the new time below.`),
};

function appointmentMail(d: AppointmentMail, heading: string, intro: string): RenderedEmail {
  const rows: [string, string][] = [
    ['When', d.when],
    ['Doctor', `${d.doctor}${d.department ? ` · ${d.department}` : ''}`],
    ['Booking ref', d.ref],
    ['Patient ID', d.mrn],
  ];
  return {
    subject: `${heading}: ${d.ref} · ${d.when}`,
    text: `Hello ${d.name},\n\n${intro}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nPlease arrive 10 minutes early and show your Patient ID at reception.`,
    html: layout(`<p>Hello ${esc(d.name)},</p><p>${esc(intro)}</p>
<table style="border-collapse:collapse;font-size:14px;margin:12px 0">${rows
      .map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#64748B">${esc(k)}</td><td style="padding:4px 0;font-weight:700">${esc(v)}</td></tr>`)
      .join('')}</table>
<p style="font-size:13px;color:#64748B">Please arrive 10 minutes early and show your Patient ID at reception.</p>`),
  };
}
