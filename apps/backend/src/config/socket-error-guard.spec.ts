import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { Logger } from '@nestjs/common';
import { guardClientSocketErrors } from './socket-error-guard.js';

// A bare EventEmitter stands in for both the http.Server and an accepted
// socket — enough to exercise the `connection` -> `error` wiring without a
// real TCP listener.
function fakeLogger(): { logger: Logger; debug: jest.Mock } {
  const debug = jest.fn();
  return { logger: { debug } as unknown as Logger, debug };
}

describe('guardClientSocketErrors', () => {
  it('attaches an error listener to every accepted socket', () => {
    const server = new EventEmitter();
    const { logger } = fakeLogger();
    guardClientSocketErrors(server as unknown as Server, logger);

    const socket = new EventEmitter();
    server.emit('connection', socket);

    expect(socket.listenerCount('error')).toBe(1);
  });

  it('swallows a client socket error instead of letting it crash the process', () => {
    const server = new EventEmitter();
    const { logger, debug } = fakeLogger();
    guardClientSocketErrors(server as unknown as Server, logger);

    const socket = new EventEmitter();
    server.emit('connection', socket);

    // Without a listener, emitting `error` on an EventEmitter throws (the
    // crash this guard prevents). With the guard it must not throw.
    const err = Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
    });
    expect(() => socket.emit('error', err)).not.toThrow();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('ECONNRESET'));
  });

  it('falls back to the error message when no error code is present', () => {
    const server = new EventEmitter();
    const { logger, debug } = fakeLogger();
    guardClientSocketErrors(server as unknown as Server, logger);

    const socket = new EventEmitter();
    server.emit('connection', socket);

    expect(() => socket.emit('error', new Error('boom'))).not.toThrow();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});
