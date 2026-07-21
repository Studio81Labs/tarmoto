import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { requestAbortSignal } from './request-abort.js';

describe('requestAbortSignal', () => {
  function emitters(): {
    request: EventEmitter & { aborted: boolean };
    response: EventEmitter & { destroyed: boolean };
  } {
    return {
      request: Object.assign(new EventEmitter(), { aborted: false }),
      response: Object.assign(new EventEmitter(), { destroyed: false }),
    };
  }

  it('aborts when the HTTP request disconnects', () => {
    const { request, response } = emitters();
    const result = requestAbortSignal(
      request as unknown as Request,
      response as unknown as Response,
    );

    request.emit('aborted');

    expect(result.signal.aborted).toBe(true);
    expect(result.signal.reason).toMatchObject({ name: 'AbortError' });
  });

  it('aborts when the response socket closes', () => {
    const { request, response } = emitters();
    const result = requestAbortSignal(
      request as unknown as Request,
      response as unknown as Response,
    );

    response.emit('close');

    expect(result.signal.aborted).toBe(true);
  });

  it('removes listeners on cleanup so a normal response is not aborted', () => {
    const { request, response } = emitters();
    const result = requestAbortSignal(
      request as unknown as Request,
      response as unknown as Response,
    );

    result.cleanup();
    response.emit('close');
    request.emit('aborted');

    expect(result.signal.aborted).toBe(false);
  });

  it('starts aborted when the socket was already destroyed', () => {
    const { request, response } = emitters();
    response.destroyed = true;

    const result = requestAbortSignal(
      request as unknown as Request,
      response as unknown as Response,
    );

    expect(result.signal.aborted).toBe(true);
    result.cleanup();
  });
});
