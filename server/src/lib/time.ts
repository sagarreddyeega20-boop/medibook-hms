/**
 * Hospital-local time helpers. The database stores UTC; schedules are defined in hospital-local
 * minutes (settings: hospital.timezone = Asia/Kolkata). IST has no daylight saving, so a fixed
 * +05:30 offset is exact. A "date key" is a local calendar date, "YYYY-MM-DD".
 */
export const HOSPITAL_TZ = 'Asia/Kolkata';
const OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
export const isDateKey = (s: string) => DATE_KEY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Local calendar date of an instant. */
export const localDateKey = (d: Date = new Date()) => new Date(d.getTime() + OFFSET_MS).toISOString().slice(0, 10);

/** UTC instant of local midnight on `dateKey`. */
export const localMidnight = (dateKey: string) => new Date(Date.parse(`${dateKey}T00:00:00Z`) - OFFSET_MS);

/** UTC instant of `minute` minutes after local midnight on `dateKey`. */
export const atLocalMinute = (dateKey: string, minute: number) => new Date(localMidnight(dateKey).getTime() + minute * 60_000);

/** 0 = Sunday … 6 = Saturday, for a local date. */
export const localDayOfWeek = (dateKey: string) => new Date(`${dateKey}T00:00:00Z`).getUTCDay();

/** Minutes since local midnight of an instant. */
export const localMinuteOfDay = (d: Date) => {
  const local = new Date(d.getTime() + OFFSET_MS);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
};

export const addDays = (dateKey: string, n: number) => new Date(Date.parse(`${dateKey}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** [start, end) of a local day, as UTC instants. */
export const localDayRange = (dateKey: string) => {
  const start = localMidnight(dateKey);
  return { start, end: new Date(start.getTime() + DAY_MS) };
};

const whenFmt = new Intl.DateTimeFormat('en-IN', { timeZone: HOSPITAL_TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
/** "Sat, 14 Nov, 11:30 am" in hospital time — for emails. */
export const formatLocal = (d: Date) => whenFmt.format(d);

/** "09:30" for a minute-of-day. */
export const minuteLabel = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
