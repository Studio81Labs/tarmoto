import type { Request, Response } from 'express';

/**
 * AbortSignal that fires while a controller is still working if its HTTP
 * client disconnects. The returned cleanup must run before the normal response
 * is written, otherwise the response's ordinary `close` event looks aborted.
 */
export function requestAbortSignal(
  request: Request,
  response: Response | undefined = request.res,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () =>
    controller.abort(new DOMException('Client disconnected', 'AbortError'));
  const listensToRequest = typeof request.once === 'function';
  const listensToResponse = typeof response?.once === 'function';
  if (listensToRequest) request.once('aborted', abort);
  if (listensToResponse) response.once('close', abort);
  if (request.aborted || response?.destroyed) abort();
  return {
    signal: controller.signal,
    cleanup: () => {
      if (listensToRequest) request.off('aborted', abort);
      if (listensToResponse) response.off('close', abort);
    },
  };
}
