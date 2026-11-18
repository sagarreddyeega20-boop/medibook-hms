import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { corsOrigins } from '../config/env.js';

/** Rooms used for live updates. Services emit after their DB transaction commits. */
export const Rooms = {
  reception: 'reception',
  /** Anyone looking at free slots (patient portal, admin): told when a doctor's day changes. */
  slots: 'slots',
  /** Billing counter and accounts: told when an invoice, payment, refund or reconciliation changes. */
  billing: 'billing',
  department: (id: string) => `dept:${id}`,
  doctor: (id: string) => `doctor:${id}`,
  user: (id: string) => `user:${id}`,
} as const;

/** Decides which rooms a connecting socket may join, from its Cookie header (set by the auth layer). */
export type RoomResolver = (cookieHeader: string | undefined) => Promise<string[]>;

let io: Server | null = null;

export function initSocket(server: HttpServer, resolveRooms: RoomResolver) {
  io = new Server(server, { cors: { origin: corsOrigins, credentials: true } });
  io.on('connection', async (socket) => {
    try {
      const rooms = await resolveRooms(socket.handshake.headers.cookie);
      if (!rooms.length) {
        socket.emit('unauthorized');
        socket.disconnect(true);
        return;
      }
      await socket.join(rooms);
      socket.emit('ready', { rooms: rooms.filter((r) => !r.startsWith('user:')) });
    } catch {
      socket.disconnect(true);
    }
  });
  return io;
}

export function emitTo(room: string, event: string, payload: unknown) {
  io?.to(room).emit(event, payload);
}

/** A doctor's day changed (hold, booking, cancel, check-in, queue move, schedule or leave edit). */
export function emitScheduleChanged(change: { doctorId: string; date: string; kind: string }) {
  emitTo(Rooms.reception, 'board:changed', change);
  emitTo(Rooms.slots, 'slots:changed', { doctorId: change.doctorId, date: change.date });
}
