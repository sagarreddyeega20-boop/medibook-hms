/**
 * npm run mail:test -- you@example.com
 * Sends one test email with the configured transport and prints success or the exact SMTP error.
 */
import { describeMailTransport, explainMailError, mailTransport, sendMail, verifyMailTransport } from '../src/lib/mailer.js';
import { testEmail } from '../src/modules/notifications/templates.js';

const to = process.argv.slice(2).find((a) => !a.startsWith('-'));
if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
  console.error('Usage: npm run mail:test -- you@example.com');
  process.exit(2);
}

if (mailTransport !== 'smtp') {
  console.error(`${describeMailTransport()}\n✗ No email was sent. Set SMTP_USER and SMTP_PASS in .env (or MAIL_TRANSPORT=smtp) and try again.`);
  process.exit(1);
}

if (!(await verifyMailTransport())) process.exit(1);

try {
  const { messageId } = await sendMail({ to, ...testEmail(describeMailTransport().replace(/^\[mail\] /, '')) });
  console.log(`✓ Test email sent to ${to} (message ID ${messageId}). Check the inbox — and the Spam folder.`);
  process.exit(0);
} catch (err) {
  console.error(`✗ Sending to ${to} failed: ${explainMailError(err)}`);
  process.exit(1);
}
