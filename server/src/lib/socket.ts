import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { corsOrigins } from '../config/env.js';

/** Rooms used for live updates. Services emit after their DB transaction commits. */
export const Rooms = {
  reception: 'reception',
  department: (id: string) => `dept:${id}`,
  doctor: (id: string) => `doctor:${id}`,
  user: (id: string) => `user:${id}`,
} as const;

let io: Server | null = null;

export function initSocket(server: HttpServer) {
  io = new Server(server, { cors: { origin: corsOrigins, credentials: true } });
  io.on('connection', (socket) => {
    // Room joining will be gated by auth once the auth module is built.
    socket.emit('hello', { ok: true });
  });
  return io;
}

export function emitTo(room: string, event: string, payload: unknown) {
  io?.to(room).emit(event, payload);
}
