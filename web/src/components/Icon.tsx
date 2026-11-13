import type { SVGProps } from 'react';

/** Small stroke icon set used across v1 patterns. Decorative by default (aria-hidden). */
const PATHS = {
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.35-4.35',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z',
  arrowRight: 'M5 12h14M13 5l7 7-7 7',
  arrowLeft: 'M19 12H5M11 19l-7-7 7-7',
  chevronLeft: 'M15 18l-6-6 6-6',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z',
  bot: 'M12 8V4H8M4 12a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v4a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM9 13v1M15 13v1',
  check: 'M20 6 9 17l-5-5',
  timer: 'M10 2h4M12 14l3-3M12 22a8 8 0 1 0 0-16 8 8 0 0 0 0 16z',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z',
  bolt: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z',
  card: 'M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zM2 10h20M6 15h4',
  bank: 'M3 21h18M3 10h18M5 6l7-3 7 3M6 10v11M10 10v11M14 10v11M18 10v11',
  wallet: 'M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3M21 11h-5a2 2 0 0 0 0 4h5v-4z',
  clinic: 'M3 21V9l9-6 9 6v12zM12 10v6M9 13h6',
  menu: 'M4 6h16M4 12h16M4 18h16',
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
  close: 'M18 6 6 18M6 6l12 12',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, strokeWidth = 2, ...rest }: { name: IconName; size?: number; strokeWidth?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The v1 logo: teal rounded tile with a white "+". */
export function LogoTile({ size = 34 }: { size?: number }) {
  return (
    <span className="mb-logo-tile" style={{ width: size, height: size }} aria-hidden="true">
      <Icon name="plus" size={Math.round(size * 0.55)} strokeWidth={2.6} />
    </span>
  );
}
