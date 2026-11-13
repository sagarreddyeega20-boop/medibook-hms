import { useCallback, useEffect, useState } from 'react';

/** Seconds left until a deadline, ticking once a second. `start(seconds)` resets it. */
export function useCountdown(initialSeconds = 0) {
  const [deadline, setDeadline] = useState(() => Date.now() + initialSeconds * 1000);
  const [now, setNow] = useState(() => Date.now());
  const left = Math.max(0, Math.ceil((deadline - now) / 1000));

  useEffect(() => {
    if (left <= 0) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [left > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = useCallback((seconds: number) => {
    setNow(Date.now());
    setDeadline(Date.now() + seconds * 1000);
  }, []);

  return { left, start };
}

/** 272 → "4:32" */
export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
