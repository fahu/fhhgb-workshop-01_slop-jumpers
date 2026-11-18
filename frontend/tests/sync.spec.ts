import { expect, test } from '@playwright/test';
import { CheckpointSync } from '../src/runs/sync';

const runId = 'fedcba98-1234-4321-9876-abcdef012345';
const checkpointProgress = { distance: 1500, tokens: 5, elapsedMs: 22500 };
const finalProgress = { distance: 1680, tokens: 8, elapsedMs: 25000, collisionId: 'seven-finger-hand' };

function storage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, saved: string) => { value = saved; },
  };
}

const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

test('a failed save survives a reload and retries in order with the original payloads', async () => {
  const disk = storage();
  const writes: { path: string; body: unknown }[] = [];
  let loseConfirmation = true;
  globalThis.fetch = async (path, init) => {
    writes.push({ path: String(path), body: JSON.parse(init!.body as string) });
    if (loseConfirmation) {
      loseConfirmation = false;
      return Response.json({ message: 'Confirmation lost' }, { status: 504 });
    }
    return Response.json({ finished: String(path).endsWith('/finish') });
  };

  const beforeReload = new CheckpointSync(() => {}, disk);
  const original = { ...checkpointProgress };
  beforeReload.enqueue(runId, 1, original);
  original.tokens = 100;
  beforeReload.enqueue(runId, 0, finalProgress);
  await expect.poll(() => writes.length).toBe(1);

  const receipts: boolean[] = [];
  const reloaded = new CheckpointSync(state => {
    if (state.receipt) {
      receipts.push(state.receipt.finished);
    }
  }, disk);
  reloaded.announce();
  expect(writes).toHaveLength(1);
  await reloaded.retry();

  expect(writes).toEqual([
    { path: `/api/runs/${runId}/checkpoints/1`, body: checkpointProgress },
    { path: `/api/runs/${runId}/checkpoints/1`, body: checkpointProgress },
    { path: `/api/runs/${runId}/finish`, body: finalProgress },
  ]);
  expect(receipts).toEqual([false, true]);
  expect(disk.getItem()).toBe('[]');
});

test('an invalid saved entry does not block a valid checkpoint from an earlier visit', async () => {
  const disk = storage(JSON.stringify([null, { runId }, { runId, checkpoint: 1, progress: checkpointProgress }]));
  const paths: string[] = [];
  globalThis.fetch = async path => {
    paths.push(String(path));
    return Response.json({ finished: false });
  };

  await new CheckpointSync(() => {}, disk).retry();

  expect(paths).toEqual([`/api/runs/${runId}/checkpoints/1`]);
  expect(disk.getItem()).toBe('[]');
});

test('a storage write failure still allows the save to reach the server', async () => {
  const states: { storageAvailable: boolean; pending: number }[] = [];
  let confirmed = false;
  globalThis.fetch = async () => Response.json({ finished: true });
  const sync = new CheckpointSync(state => {
    states.push(state);
    if (state.receipt) {
      confirmed = state.receipt.finished;
    }
  }, {
    getItem: () => null,
    setItem: () => { throw new DOMException('Disk quota exceeded', 'QuotaExceededError'); },
  });

  sync.enqueue(runId, 0, finalProgress);

  await expect.poll(() => confirmed).toBe(true);
  expect(states.at(-1)).toMatchObject({ storageAvailable: false, pending: 0, error: '' });
});
