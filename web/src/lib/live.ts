import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';

/**
 * Live updates over Socket.IO (proxied by Vite at /socket.io). The server decides rooms from the
 * session cookie: reception staff get "board:changed", everyone signed in gets "slots:changed".
 */
let socket: Socket | null = null;
function getSocket() {
  socket ??= io({ path: '/socket.io', withCredentials: true, transports: ['websocket', 'polling'] });
  return socket;
}

/** Re-runs `onChange` (debounced ~150 ms) whenever one of `events` arrives, and after a reconnect. */
export function useLive(events: string[], onChange: (payload: unknown) => void, enabled = true) {
  const cb = useRef(onChange);
  cb.current = onChange;
  const key = events.join('|');

  useEffect(() => {
    if (!enabled) return;
    const s = getSocket();
    if (s.disconnected) s.connect();
    let timer: number | undefined;
    const fire = (payload: unknown) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => cb.current(payload), 150);
    };
    const names = key.split('|');
    names.forEach((e) => s.on(e, fire));
    s.on('ready', fire); // (re)connected: catch up on anything missed
    return () => {
      window.clearTimeout(timer);
      names.forEach((e) => s.off(e, fire));
      s.off('ready', fire);
    };
  }, [key, enabled]);
}

/** Drop the connection on logout so the next user gets fresh rooms. */
export function disconnectLive() {
  socket?.disconnect();
  socket = null;
}
