/**
 * Rule-based booking assistant (like v1): maps symptoms and specialities to departments, reads simple dates,
 * and recognises "my appointments" / "cancel <ref>". No AI, no medical advice — it only routes to the booking API.
 */
import type { Department } from './booking';
import { addDays, todayKey } from './time';

export type Intent =
  | { kind: 'greet' }
  | { kind: 'mine' }
  | { kind: 'cancel'; ref?: string }
  | { kind: 'reschedule' }
  | { kind: 'book'; department?: Department; matched?: string; date?: string }
  | { kind: 'emergency' }
  | { kind: 'unknown' };

/** Department code → words that point to it (symptoms, specialist names). Departments are matched by name too. */
const KEYWORDS: Record<string, string[]> = {
  CARD: ['heart', 'chest pain', 'chest', 'palpitation', 'blood pressure', 'bp', 'hypertension', 'cardio', 'cardiac', 'breathless', 'cardiologist', 'ecg'],
  GEN: ['fever', 'cold', 'cough', 'headache', 'flu', 'body pain', 'vomit', 'stomach', 'check-up', 'checkup', 'infection', 'sore throat', 'tired', 'weakness', 'physician', 'general', 'gp', 'doctor'],
  NUTR: ['diet', 'weight', 'nutrition', 'obesity', 'nutritionist', 'dietitian', 'dietician', 'eating', 'sugar', 'diabetes'],
  DERM: ['skin', 'rash', 'acne', 'itch', 'hair', 'eczema', 'pimple', 'dermatologist', 'nail', 'allergy'],
  ORTHO: ['bone', 'joint', 'knee', 'back pain', 'fracture', 'sprain', 'spine', 'shoulder', 'ortho', 'orthopaedic', 'orthopedic', 'neck pain', 'ankle'],
};
/** Generic words ranked below specific ones (so "doctor for my skin" picks Dermatology). */
const WEAK = new Set(['doctor', 'general', 'gp']);

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const has = (text: string, word: string) => new RegExp(`(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(text);

export function parseDate(text: string, today = todayKey()): string | undefined {
  const t = text.toLowerCase();
  if (/day after tomorrow/.test(t)) return addDays(today, 2);
  if (/\btomorrow\b|\btmrw\b/.test(t)) return addDays(today, 1);
  if (/\btoday\b|\btonight\b|\bnow\b|\basap\b/.test(t)) return today;
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  for (let i = 0; i < 7; i++) {
    if (new RegExp(`\\b(next )?${DAYS[i]}\\b|\\b${DAYS[i]!.slice(0, 3)}\\b`).test(t)) {
      const ahead = (i - dow + 7) % 7;
      return addDays(today, /next /.test(t) && ahead === 0 ? 7 : ahead);
    }
  }
  // "14 nov", "nov 14", "14/11"
  const m1 = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/) ?? null;
  const m2 = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/) ?? null;
  const m3 = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  let day: number | undefined;
  let month: number | undefined;
  if (m1) [day, month] = [Number(m1[1]), MONTHS.indexOf(m1[2]!)];
  else if (m2) [day, month] = [Number(m2[2]), MONTHS.indexOf(m2[1]!)];
  else if (m3) [day, month] = [Number(m3[1]), Number(m3[2]) - 1];
  if (day === undefined || month === undefined || month < 0 || month > 11 || day < 1 || day > 31) return undefined;
  let year = Number(today.slice(0, 4));
  let key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (key < today) key = `${++year}-${key.slice(5)}`;
  return Number.isNaN(Date.parse(key)) ? undefined : key;
}

export function matchDepartment(text: string, departments: Department[]): { department: Department; matched: string } | undefined {
  const t = text.toLowerCase();
  let best: { department: Department; matched: string; score: number } | undefined;
  for (const d of departments) {
    const words = [d.name.toLowerCase(), d.code.toLowerCase(), ...(KEYWORDS[d.code] ?? [])];
    for (const w of words) {
      if (!has(t, w)) continue;
      const score = (WEAK.has(w) ? 1 : 10) + w.length / 100 + (w === d.name.toLowerCase() ? 5 : 0);
      if (!best || score > best.score) best = { department: d, matched: w, score };
    }
  }
  return best && { department: best.department, matched: best.matched };
}

export function parse(text: string, departments: Department[]): Intent {
  const t = text.trim().toLowerCase();
  if (!t) return { kind: 'unknown' };
  if (/\b(108|emergency|unconscious|severe bleeding|can't breathe|cannot breathe|stroke)\b/.test(t)) return { kind: 'emergency' };
  const ref = t.match(/\bapt-?\s?(\d{1,10})\b/);
  if (/\bcancel\b/.test(t)) return { kind: 'cancel', ref: ref ? `APT-${ref[1]!.padStart(6, '0')}` : undefined };
  if (/\breschedul|\bmove my\b|\bchange (my )?(appointment|booking|time)\b/.test(t)) return { kind: 'reschedule' };
  if (/\b(my|show|view|list|upcoming)\b.*\b(appointment|booking|visit)s?\b|^appointments?$/.test(t)) return { kind: 'mine' };
  if (/^(hi|hello|hey|namaste|good (morning|afternoon|evening))\b[!. ]*$/.test(t)) return { kind: 'greet' };
  const dept = matchDepartment(t, departments);
  const date = parseDate(t);
  if (dept || date || /\b(book|appointment|consult|see a|need a|slot)\b/.test(t)) return { kind: 'book', department: dept?.department, matched: dept?.matched, date };
  return { kind: 'unknown' };
}
