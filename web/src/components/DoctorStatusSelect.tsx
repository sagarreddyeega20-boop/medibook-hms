import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cx } from '../lib/cx';
import { addDays, dayLabel, keyOf, timeLabel, todayKey } from '../lib/time';
import { Field } from './Input';
import { StatusDot, doctorStatusRank } from './StatusDot';

export interface DoctorStatusOption {
  id: string;
  name: string;
  specialty?: string | null;
  /** Calculated live status: AVAILABLE | IN_CONSULTATION | RUNNING_LATE | OFF_DUTY | ON_LEAVE. */
  status: string;
  lateByMinutes?: number;
  nextFreeSlot?: { start: string } | null;
}

const STATUS_TEXT: Record<string, string> = {
  AVAILABLE: 'Available',
  IN_CONSULTATION: 'In consultation',
  RUNNING_LATE: 'Running late',
  OFF_DUTY: 'Off duty',
  ON_LEAVE: 'On leave',
};

const nextFreeText = (iso?: string) => {
  if (!iso) return 'No free slot in the next 2 weeks';
  const key = keyOf(iso);
  const day = key === todayKey() ? 'today' : key === addDays(todayKey(), 1) ? 'tomorrow' : dayLabel(key);
  return `Next free: ${day} ${timeLabel(iso)}`;
};

export const doctorStatusText = (d: DoctorStatusOption) => `${STATUS_TEXT[d.status] ?? d.status} · ${nextFreeText(d.nextFreeSlot?.start)}`;

/** Green first, then amber, then red; by name within a colour. */
export const sortByDoctorStatus = <T extends DoctorStatusOption>(list: T[]) =>
  [...list].sort((a, b) => doctorStatusRank(a.status) - doctorStatusRank(b.status) || a.name.localeCompare(b.name));

interface Props {
  label?: string;
  hint?: string;
  value: string;
  onChange: (id: string) => void;
  doctors: DoctorStatusOption[];
  /** First option with value "" (e.g. "Any doctor in the department"). */
  emptyLabel?: string;
  disabled?: boolean;
  loading?: boolean;
}

/**
 * Doctor picker that shows each doctor's live status: a StatusDot plus the status in words and the
 * next free slot (so meaning never relies on colour). Every doctor stays selectable — a red one can be
 * booked for a later date. A keyboard-accessible listbox styled like `Select`.
 */
export function DoctorStatusSelect({ label, hint, value, onChange, doctors, emptyLabel, disabled, loading }: Props) {
  const id = useId();
  const listId = `${id}-list`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  const options = useMemo(() => {
    const sorted = sortByDoctorStatus(doctors);
    return [...(emptyLabel !== undefined ? [null] : []), ...sorted] as (DoctorStatusOption | null)[];
  }, [doctors, emptyLabel]);
  const selected = doctors.find((d) => d.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const show = () => {
    setActive(Math.max(0, options.findIndex((o) => (o?.id ?? '') === value)));
    setOpen(true);
  };
  const pick = (o: DoctorStatusOption | null) => {
    onChange(o?.id ?? '');
    setOpen(false);
  };
  const onKey = (e: KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(options[active] ?? null); }
    else if (e.key === 'Escape' || e.key === 'Tab') setOpen(false);
  };

  const optionId = (i: number) => `${id}-opt-${i}`;
  return (
    <Field id={id} label={label} hint={hint}>
      <div className="mb-dselect" ref={root}>
        <button
          id={id}
          type="button"
          className="mb-select mb-dselect__trigger"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open ? optionId(active) : undefined}
          disabled={disabled}
          onClick={() => (open ? setOpen(false) : show())}
          onKeyDown={onKey}
        >
          {selected ? (
            <span className="mb-dselect__value">
              <StatusDot status={selected.status} />
              <span className="mb-dselect__name">{selected.name}</span>
              <span className="mb-dselect__meta">{STATUS_TEXT[selected.status] ?? selected.status}</span>
            </span>
          ) : (
            <span className="mb-dselect__value mb-dselect__placeholder">{loading ? 'Loading doctors…' : (emptyLabel ?? 'Choose a doctor…')}</span>
          )}
        </button>
        {open && (
          <ul className="mb-dselect__list" id={listId} role="listbox" aria-label={label}>
            {options.map((o, i) => (
              <li
                key={o?.id ?? ''}
                id={optionId(i)}
                role="option"
                aria-selected={(o?.id ?? '') === value}
                className={cx('mb-dselect__option', i === active && 'is-active', (o?.id ?? '') === value && 'is-selected')}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o)}
              >
                {o ? (
                  <>
                    <StatusDot status={o.status} className="mb-dselect__dot" />
                    <span className="mb-dselect__text">
                      <span className="mb-dselect__name">{o.name}{o.specialty ? <small> · {o.specialty}</small> : null}</span>
                      <span className="mb-dselect__meta">{doctorStatusText(o)}</span>
                    </span>
                  </>
                ) : (
                  <span className="mb-dselect__text"><span className="mb-dselect__name">{emptyLabel}</span></span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Field>
  );
}
