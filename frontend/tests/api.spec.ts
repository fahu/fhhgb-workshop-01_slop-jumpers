import { test, expect } from '@playwright/test';
import { ApiError, errorMessage, request } from '../src/api';

const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

test('HTTP errors use friendly messages while preserving diagnostic details', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Internal fault.request_failure: HTTP 502' }), { status: 502 });
  const error = await request('/leaderboard').catch(error => error);
  expect(error).toBeInstanceOf(ApiError);
  expect(errorMessage(error)).toBe('The server is currently unavailable.');
  expect(error.status).toBe(502);
  expect(error.serverMessage).toContain('fault.request_failure');
  // Gateways can return HTML, null or an unfamiliar status instead of the API's JSON shape.
  globalThis.fetch = async () => new Response('<h1>Proxy stack trace</h1>', { status: 503 });
  expect(errorMessage(await request('/leaderboard').catch(error => error))).toContain('server is busy');
  globalThis.fetch = async () => new Response('null', { status: 599 });
  expect(errorMessage(await request('/leaderboard').catch(error => error))).toBe('We couldn’t complete that action. Please try again.');
});

test('connection failures and timeouts are readable but intentional cancellation is preserved', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  expect(errorMessage(await request('/activity').catch(error => error))).toContain('Check your connection');
  globalThis.fetch = async () => { throw new DOMException('signal timed out', 'TimeoutError'); };
  expect(errorMessage(await request('/activity').catch(error => error))).toBe('The server is taking too long to respond.');
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = async () => { throw controller.signal.reason; };
  expect(await request('/activity', 'GET', undefined, undefined, controller.signal).catch(error => error)).toBe(controller.signal.reason);
});
