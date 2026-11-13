import { Rooms } from '../../lib/socket.js';
import { SESSION_COOKIE, sessionService } from './session.service.js';

/**
 * Which Socket.IO rooms a connection may join, decided from its session cookie.
 * Reception staff get the live board; everyone signed in may watch free slots; nobody else connects.
 */
export async function socketRooms(cookieHeader: string | undefined): Promise<string[]> {
  const token = cookieHeader
    ?.split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (!token) return [];
  const session = await sessionService.touch(decodeURIComponent(token));
  if (!session) return [];
  const rooms: string[] = [Rooms.slots, Rooms.user(session.userId)];
  if (session.permissions.includes('reception:read')) rooms.push(Rooms.reception);
  return rooms;
}
