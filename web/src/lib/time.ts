/**
 * Hospital-local (IST) display helpers. The API sends UTC instants; schedules are local.
 * A "date key" is a hospital-local calendar date, YYYY-MM-DD.
 */
const TZ = 'Asia/Kolkata';
const OFFSET_MS = 330 * 60_000;

export const todayKey = (d = new Date()) => new Date(d.getTime() + OFFSET_MS).toISOString().slice(0, 10);
export const addDays = (key: string, n: number) => new Date(Date.parse(`${key}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const keyOf = (iso: string) => todayKey(new Date(iso));

const timeFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
const longDayFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });

/** "11:30 am" */
export const timeLabel = (iso: string) => timeFmt.format(new Date(iso)).replace(/\s?([ap])\.?m\.?/i, (_, x: string) => ` ${x.toUpperCase()}M`);
/** "Sat, 14 Nov" for a date key */
export const dayLabel = (key: string) => dayFmt.format(new Date(`${key}T00:00:00Z`));
/** "Saturday, 14 November" */
export const longDayLabel = (key: string) => longDayFmt.format(new Date(`${key}T00:00:00Z`));
/** "Today" / "Tomorrow" / "Sat, 14 Nov" */
export const relativeDay = (key: string) => (key === todayKey() ? 'Today' : key === addDays(todayKey(), 1) ? 'Tomorrow' : dayLabel(key));
/** "Sat, 14 Nov · 11:30 AM" */
export const whenLabel = (iso: string) => `${relativeDay(keyOf(iso))} · ${timeLabel(iso)}`;
/** A Date positioned so .getDate()/.getMonth() give the hospital-local day (for DateTile). */
export const tileDate = (iso: string) => {
  const [y, m, d] = keyOf(iso).split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};
/** "HH:MM" ↔ minutes */
export const toHHMM = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** For sentences: "today" / "tomorrow" / "on Sat, 14 Nov". */
export const onDay = (key: string) => (key === todayKey() ? 'today' : key === addDays(todayKey(), 1) ? 'tomorrow' : `on ${dayLabel(key)}`);
/** For sentences: "tomorrow at 11:30 AM" / "on Sat, 14 Nov at 11:30 AM". */
export const sentenceWhen = (iso: string) => `${onDay(keyOf(iso))} at ${timeLabel(iso)}`;
