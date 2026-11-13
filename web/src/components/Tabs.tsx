import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem {
  id: string;
  label: string;
  count?: number;
}

interface TabsProps {
  tabs: TabItem[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  children?: ReactNode; // panel content for the active tab
}

export function Tabs({ tabs, value, onChange, label, children }: TabsProps) {
  const base = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = (index + dir + tabs.length) % tabs.length;
    refs.current[next]?.focus();
    onChange(tabs[next]!.id);
  };

  return (
    <div>
      <div className="mb-tabs" role="tablist" aria-label={label}>
        {tabs.map((t, i) => {
          const selected = t.id === value;
          return (
            <button
              key={t.id}
              ref={(el) => { refs.current[i] = el; }}
              type="button"
              role="tab"
              id={`${base}-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel`}
              tabIndex={selected ? 0 : -1}
              className="mb-tab"
              onClick={() => onChange(t.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {t.label}
              {t.count !== undefined && <span className="mb-tab__count">{t.count}</span>}
            </button>
          );
        })}
      </div>
      {children !== undefined && (
        <div className="mb-tabpanel" role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${value}`}>
          {children}
        </div>
      )}
    </div>
  );
}
