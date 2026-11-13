/** "Rahul Kumar" → "RK" */
export const initials = (name: string) =>
  name.replace(/^Dr\.?\s+/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2, minimumFractionDigits: 0 });

/** Money is stored as integer paise; this is the only place it becomes rupees for display. 62400 → "₹624" */
export const formatPaise = (paise: number) => inr.format(paise / 100);

/** Time-of-day greeting for staff dashboards ("Good morning, Dr. Ananya"). */
export const greeting = (d = new Date()) => {
  const h = d.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};
