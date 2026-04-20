import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '@/stores/auth';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? '';

let socket: Socket | null = null;

export function connectSocket(): Socket {
  if (socket?.connected) return socket;

  const token = useAuthStore.getState().accessToken;

  socket = io(WS_URL, {
    auth: { token },
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
  });

  socket.on('connect', () => {
    console.log('[WS] Connected');
  });

  socket.on('disconnect', (reason) => {
    console.log('[WS] Disconnected:', reason);
  });

  socket.on('connect_error', (err) => {
    console.error('[WS] Connection error:', err.message);
  });

  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

export function getSocket(): Socket | null {
  return socket;
}

// ── Trip collaboration events ──

export function joinTripRoom(tripId: string) {
  socket?.emit('trip:join', { tripId });
}

export function leaveTripRoom(tripId: string) {
  socket?.emit('trip:leave', { tripId });
}

export function sendCursorPosition(tripId: string, position: { lng: number; lat: number }) {
  socket?.emit('trip:cursor', { tripId, position });
}

export function onTripUpdate(callback: (data: unknown) => void) {
  socket?.on('trip:updated', callback);
  return () => { socket?.off('trip:updated', callback); };
}

export function onCollaboratorCursor(callback: (data: { userId: string; position: { lng: number; lat: number } }) => void) {
  socket?.on('trip:cursor', callback);
  return () => { socket?.off('trip:cursor', callback); };
}

// ── Hazard alerts ──

export function onHazardAlert(callback: (hazard: unknown) => void) {
  socket?.on('hazard:new', callback);
  return () => { socket?.off('hazard:new', callback); };
}
