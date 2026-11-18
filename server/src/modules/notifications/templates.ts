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
  'break-glass-alert': BreakGlassMail;
}

/** Sent to every Admin when a doctor uses break-glass access. Contains no clinical content. */
export interface BreakGlassMail {
  adminName: string;
  doctor: string;
  staffCode: string;
  patient: string;
  mrn: string;
  reason: string;
  at: string; // formatted hospital time
  until: string;
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

// Email clients ignore external CSS, so the inline colours here mirror tokens.css (--primary, --bg, --text, --muted).
// Table-based layout so Gmail, Outlook and phone mail apps render it the same way.
const FONT = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";
const layout = (body: string, preheader = '') => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MediBook</title></head>
<body style="margin:0;padding:0;background:#F1F5F4;font-family:${FONT};color:#1E293B;font-size:15px;line-height:1.55">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F4;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
<tr><td style="background:#0F766E;padding:18px 28px">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="width:36px;height:36px;background:#FFFFFF;border-radius:10px;text-align:center;vertical-align:middle;font:800 24px/36px ${FONT};color:#0F766E">+</td>
<td style="padding-left:12px;font:800 20px ${FONT};color:#FFFFFF;letter-spacing:.2px">MediBook</td>
</tr></table></td></tr>
<tr><td style="padding:28px">${body}</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #E2E8F0;font-size:12px;color:#64748B">MediBook HMS · This is an automated message. If you didn't expect it, you can ignore it.</td></tr>
</table></td></tr></table></body></html>`;

const button = (href: string, label: string) =>
  `<a href="${esc(href)}" style="display:inline-block;background:#0F766E;color:#FFFFFF;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:999px">${esc(label)}</a>`;

const detailRows = (rows: [string, string][]) =>
  `<table role="presentation" style="border-collapse:collapse;font-size:14px;margin:12px 0;width:100%;background:#F8FAFA;border-radius:12px">${rows
    .map(([k, v]) => `<tr><td style="padding:8px 14px;color:#64748B;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:8px 14px;font-weight:700">${esc(v)}</td></tr>`)
    .join('')}</table>`;

/** Sent by `npm run mail:test` to check the SMTP setup. */
export function testEmail(transportInfo: string): RenderedEmail {
  return {
    subject: 'MediBook test email',
    text: `This is a test email from MediBook HMS.\n\nIf you can read this, email sending works.\n${transportInfo}`,
    html: layout(`<p style="margin:0 0 8px;font-size:18px;font-weight:800">Email sending works</p>
<p>This is a test email from MediBook HMS. OTP codes, set-password links and appointment emails will arrive the same way.</p>
<p style="font-size:13px;color:#64748B">${esc(transportInfo)}</p>`, 'MediBook email sending works'),
  };
}

export const emailTemplates: { [K in TemplateName]: (d: TemplateData[K]) => RenderedEmail } = {
  otp: (d) => ({
    subject: `${d.code} is your MediBook verification code`,
    text: `${d.name ? `Hello ${d.name},\n\n` : ''}Your MediBook ${d.purpose} code is ${d.code}. It expires in ${d.minutes} minutes.\nNever share this code with anyone — MediBook staff will never ask for it.`,
    html: layout(`${d.name ? `<p style="margin:0 0 12px">Hello ${esc(d.name)},</p>` : ''}<p style="margin:0 0 4px">Your MediBook ${d.purpose} code is</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0"><tr>${[...d.code]
      .map((ch) => `<td style="padding:0 3px"><div style="width:40px;height:52px;line-height:52px;text-align:center;border:1px solid #CBD5E1;border-radius:10px;background:#F8FAFA;font:800 26px ${FONT};color:#0F172A">${esc(ch)}</div></td>`)
      .join('')}</tr></table>
<p style="margin:0 0 16px">This code expires in <strong>${d.minutes} minutes</strong>.</p>
<p style="margin:0;padding:12px 14px;background:#FFF7ED;border:1px solid #FED7AA;border-radius:10px;font-size:13px;color:#9A3412"><strong>Never share this code</strong> with anyone — MediBook staff will never ask for it.</p>`, `Your code expires in ${d.minutes} minutes`),
  }),
  'staff-invite': (d) => ({
    subject: 'Set your MediBook HMS password',
    text: `Hello ${d.name},\n\nA MediBook HMS account has been created for you.\nStaff ID: ${d.staffCode}\nRole: ${d.role}\n\nSet your password here (the link expires in ${d.hours} hours):\n${d.link}\n\nAfter that, sign in with your staff ID, password and the code we email you.`,
    html: layout(`<p>Hello ${esc(d.name)},</p><p>A MediBook HMS account has been created for you.</p>
<p><strong>Staff ID:</strong> ${esc(d.staffCode)}<br><strong>Role:</strong> ${esc(d.role)}</p>
<p style="margin:20px 0">${button(d.link, 'Set your password')}</p>
<p style="font-size:13px;color:#64748B">The link expires in ${d.hours} hours. After that, sign in with your staff ID, password and the code we email you.<br>Button not working? Paste this into your browser:<br><span style="word-break:break-all">${esc(d.link)}</span></p>`, 'Set your MediBook HMS password'),
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
  'break-glass-alert': (d) => {
    const rows: [string, string][] = [
      ['Doctor', `${d.doctor} (${d.staffCode})`],
      ['Patient', `${d.patient} (${d.mrn})`],
      ['Reason given', d.reason],
      ['When', d.at],
      ['Access until', d.until],
    ];
    const intro = 'A doctor used break-glass access to open a patient record they have no care relationship with. Please review it in the audit log.';
    return {
      subject: `Break-glass access: ${d.doctor} opened ${d.mrn}`,
      text: `Hello ${d.adminName},\n\n${intro}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}`,
      html: layout(`<p style="margin:0 0 12px;display:inline-block;padding:4px 12px;border-radius:999px;background:#FFF7ED;color:#C2410C;font-size:12px;font-weight:700">Break-glass access</p>
<p>Hello ${esc(d.adminName)},</p><p>${esc(intro)}</p>${detailRows(rows)}`, `${d.doctor} opened ${d.mrn}`),
    };
  },
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
    html: layout(`<p style="margin:0 0 4px;font-size:18px;font-weight:800">${esc(heading)}</p>
<p>Hello ${esc(d.name)},</p><p>${esc(intro)}</p>${detailRows(rows)}
<p style="font-size:13px;color:#64748B">Please arrive 10 minutes early and show your Patient ID at reception.</p>`, `${heading} · ${d.when}`),
  };
}
