import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  text?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}

const DefaultIcon = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 10h18M9 15h6" />
  </svg>
);

export function EmptyState({ title, text, icon = DefaultIcon, action }: EmptyStateProps) {
  return (
    <div className="mb-empty">
      <div className="mb-empty__icon">{icon}</div>
      <p className="mb-empty__title">{title}</p>
      {text && <p className="mb-empty__text">{text}</p>}
      {action && <div className="mb-empty__action">{action}</div>}
    </div>
  );
}
