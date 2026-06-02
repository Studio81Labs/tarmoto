import { Logger } from '@nestjs/common';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';

/**
 * Stop a client-side connection reset from crashing the whole process.
 *
 * A raw TCP socket that the peer resets (`ECONNRESET`) or that we can't
 * finish writing to (`EPIPE`) emits an `error` event. In the brief window
 * between `accept()` and the HTTP/WebSocket layer attaching its own socket
 * handler, nothing is listening — so Node escalates it to an unhandled
 * `error` event and calls `process.exit`. The companion's reconnect storm
 * (`reconnectionAttempts: Infinity`, 1 s) hammering a flapping backend, a
 * load balancer's TCP probes, or a browser tab closing mid-handshake all
 * hit that window.
 *
 * Attaching an `error` listener in the server's `connection` event — which
 * fires synchronously at accept time, before any error can be emitted —
 * guarantees every socket has a listener from birth. These are routine
 * network events, not application faults, so we log at debug and let the
 * socket tear down on its own.
 */
export function guardClientSocketErrors(
  httpServer: Server,
  logger: Logger,
): void {
  httpServer.on('connection', (socket: Socket) => {
    socket.on('error', (err: NodeJS.ErrnoException) => {
      logger.debug(
        `Client socket error (${err.code ?? err.message}) — connection dropped`,
      );
    });
  });
}
