import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const headers = { 'X-Workshop-Token': process.env.WORKSHOP_TOKEN ?? 'local-workshop' };
async function openLab(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#network')).toBeHidden();
  await expect(page.locator('#leaderboard-overlay')).toBeHidden();
  await page.locator('#open-lab').click();
  await page.getByRole('textbox', { name: 'Instructor token' }).fill(headers['X-Workshop-Token']);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('#lab-controls')).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/workshop/reset', { headers })).ok()).toBeTruthy();
});

test('a browser-generated run ends in a real collision shown on the leaderboard', async ({ page, request }) => {
  await page.addInitScript(() => { Math.random = () => 0; });
  await openLab(page);
  const started = page.waitForResponse(response =>
    response.url().endsWith('/api/runs') && response.request().method() === 'POST');
  await page.getByLabel('Number of fake runs').fill('1');
  await page.getByRole('button', { name: 'Start fake runs', exact: true }).click();
  const run = await (await started).json();
  await expect(page.locator('#fake-run-progress')).toHaveAttribute('data-completed', '1', { timeout: 7000 });
  const saved = await (await request.get(`/api/runs/${run.id}`)).json();
  expect(saved).toMatchObject({ fakeSource: 'client', finished: true, collisionId: 'seven-finger-hand' });
  expect(saved.distance).toBeGreaterThanOrEqual(176);
  expect(saved.distance).toBeLessThan(180);
  const board = await (await request.get('/api/leaderboard')).json();
  expect(board.entries.find((entry: { alias: string }) => entry.alias === run.alias))
    .toMatchObject({ finished: true, collisionId: 'seven-finger-hand', distance: saved.distance });
  await page.getByRole('button', { name: 'Close Instructor Settings' }).click();
  await page.getByRole('button', { name: 'Refresh leaderboard', exact: true }).click();
  await expect(page.locator('#records')).toContainText('Hit Seven-Finger Hand');
});

test('exactly two browser-driven runs load levels, retry identical checkpoint writes and finish', async ({ page, request }) => {
  test.setTimeout(90000);
  await page.addInitScript(() => {
    // Two name selections, then independent target distances (1,600 m and 3,200 m).
    const values = [0.05, 0.5, 1599 / 8000, 3199 / 8000];
    Math.random = () => values.shift() ?? 0.2;
  });
  await openLab(page);
  const beforePlayers = (await (await request.get('/api/activity')).json()).players;
  expect((await request.put('/api/workshop/database', { headers, data: { maxConnections: 1 } })).ok()).toBeTruthy();
  expect((await request.put('/api/workshop/scenario', { headers, data: {
    loseConfirmation: true,
  } })).ok()).toBeTruthy();
  const starts: { playerId: string; alias: string; nationalityCode: string }[] = [];
  const writes = new Map<string, unknown[]>();
  let seedCalls = 0;
  let nextLevels = 0;
  page.on('request', req => {
    const path = new URL(req.url()).pathname;
    if (path === '/api/workshop/seed') {
      seedCalls++;
    }
    if (path === '/api/runs' && req.method() === 'POST') {
      starts.push(req.postDataJSON());
    }
    if (path === '/api/levels/2') {
      nextLevels++;
    }
    if (/\/checkpoints\/\d+$/.test(path)) {
      writes.set(path, [...(writes.get(path) ?? []), req.postDataJSON()]);
    }
  });
  await page.getByLabel('Number of fake runs').fill('2');
  await page.getByRole('button', { name: 'Start fake runs', exact: true }).click();
  await expect(page.locator('#start-fake-runs')).toBeDisabled();
  await page.getByRole('button', { name: 'Close Instructor Settings' }).click();
  await expect(page.locator('#player-count')).toHaveText(String(beforePlayers + 2), { timeout: 12000 });
  await expect(page.locator('#fake-run-progress')).toHaveAttribute('data-phase', 'finished', { timeout: 70000 });
  await expect(page.locator('#fake-run-progress')).toHaveAttribute('data-completed', '2');
  await expect(page.locator('#traffic-summary')).toContainText('0 failed');
  expect(starts).toHaveLength(2);
  expect(new Set(starts.map(run => run.playerId)).size).toBe(2);
  expect(new Set(starts.map(run => run.alias)).size).toBe(2);
  expect(starts.every(run => /^[A-Za-z]+ [A-Za-z]+$/.test(run.alias) && run.alias.length <= 20)).toBe(true);
  expect(seedCalls).toBe(0);
  expect(nextLevels).toBe(2);
  expect(writes.size).toBe(3);
  for (const payloads of writes.values()) {
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toEqual(payloads[0]);
  }
  const distances: number[] = [];
  for (const input of starts) {
    const history = await (await request.get(`/api/runs?playerId=${input.playerId}`)).json();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ alias: input.alias, nationalityCode: input.nationalityCode, fakeSource: 'client', finished: true });
    expect(history[0].tokens).toBeGreaterThan(0);
    distances.push(history[0].distance);
    expect(history[0].distance).toBeLessThanOrEqual(8000);
    const levelNumber = Math.floor(history[0].distance / 1500) + 1;
    const level = await (await request.get(`/api/levels/${levelNumber}`)).json();
    expect(level.obstacles).toContainEqual(expect.objectContaining({
      distance: levelNumber === 2 ? 1680 : 3285,
      slopId: history[0].collisionId,
    }));
    expect(history[0].elapsedMs).toBeGreaterThan(20000);
    expect(history[0].elapsedMs).toBeLessThan(43000);
  }
  distances.sort((a, b) => a - b);
  expect(distances[0]).toBeGreaterThanOrEqual(1676);
  expect(distances[0]).toBeLessThan(1680);
  expect(distances[1]).toBeGreaterThanOrEqual(3280);
  expect(distances[1]).toBeLessThan(3285);
  const humanId = await page.evaluate(() => localStorage.getItem('slop-jumpers.player'));
  expect(starts.some(run => run.playerId === humanId)).toBe(false);
  // A finite batch does not replace completed robots with new ones.
  await page.waitForTimeout(10500);
  expect(starts).toHaveLength(2);
  await page.locator('#open-lab').click();
  await page.screenshot({ path: 'test-results/fake-run-batch.png' });
});

test('invalid counts send no runs and stopping aborts queued work before a new batch', async ({ page }) => {
  test.setTimeout(45000);
  await openLab(page);
  let starts = 0;
  let pending = 0;
  let peakPending = 0;
  const requests = new Set<object>();
  page.on('request', req => {
    if (req.url().includes('/api/')) {
      requests.add(req);
      pending++;
      peakPending = Math.max(peakPending, pending);
    }
    if (new URL(req.url()).pathname === '/api/runs' && req.method() === 'POST') {
      starts++;
    }
  });
  const ended = (req: object) => {
    if (requests.delete(req)) {
      pending--;
    }
  };
  page.on('requestfinished', ended);
  page.on('requestfailed', ended);
  for (const value of ['0', '1.5', '1001']) {
    await page.getByLabel('Number of fake runs').fill(value);
    await page.getByRole('button', { name: 'Start fake runs', exact: true }).click();
    await expect(page.locator('#fake-run-progress')).toHaveAttribute('data-phase', 'idle');
  }
  expect(starts).toBe(0);
  // Hold responses so the concurrency bound is measured before any requests finish.
  // Browser requestfinished events can arrive after fetch has already released a slot.
  let releaseHeld!: () => void;
  const held = new Promise<void>(resolve => { releaseHeld = resolve; });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/workshop')) {
      await route.continue();
      return;
    }
    await held;
    await route.abort().catch(() => {});
  });
  await page.getByLabel('Number of fake runs').fill('100');
  await page.getByRole('button', { name: 'Start fake runs', exact: true }).click();
  await expect(page.locator('#fake-run-progress')).toHaveAttribute('data-phase', 'running');
  await expect.poll(() => pending).toBeGreaterThan(20);
  await expect(page.locator('#fake-run-progress')).toContainText('32 in flight');
  // 32 fake-run slots plus the visible client's occasional board and lab-status reads.
  expect(peakPending).toBeLessThanOrEqual(36);
  await page.locator('#stop-fake-runs').click();
  await expect(page.locator('#fake-run-progress')).toHaveAttribute('data-phase', 'stopped', { timeout: 10000 });
  await expect(page.locator('#fake-run-progress')).toContainText('0 in flight · 0 queued');
  releaseHeld();
  await page.unroute('**/api/**');
  const afterStop = starts;
  await page.waitForTimeout(800);
  expect(starts).toBe(afterStop);
  await page.getByLabel('Number of fake runs').fill('1');
  await page.getByRole('button', { name: 'Start fake runs', exact: true }).click();
  await expect(page.locator('#fake-run-progress')).toHaveAttribute('data-phase', 'running');
  await page.locator('#stop-fake-runs').click();
  await expect(page.locator('#fake-run-progress')).toHaveAttribute('data-phase', 'stopped');
  await expect(page.locator('#fake-run-progress')).toContainText('1 cancelled');
});

test('instructor seeds finished runs and removes only marked data, stopping the active browser batch', async ({ page, request }) => {
  test.skip(!!process.env.DEMO_URL, 'Cleanup is tested only with the default disposable local backend.');
  test.setTimeout(45000);
  // This suite runs against a disposable database, never the workshop database.
  expect((await request.delete('/api/workshop/fake-runs', { headers })).ok()).toBe(true);
  const playerId = crypto.randomUUID();
  const human = await (await request.post('/api/runs', { data: { playerId, alias: 'Keep this player', nationalityCode: 'AT' } })).json();
  expect((await request.put(`/api/runs/${human.id}/finish`, { data: { distance: 500, tokens: 3, elapsedMs: 10000 } })).ok()).toBe(true);
  const before = await (await request.get('/api/workshop/runs', { headers })).json();
  await openLab(page);
  await page.getByLabel('Number of runs to seed').fill('37');
  await page.getByRole('button', { name: 'Add fake runs to database', exact: true }).click();
  await expect(page.locator('#data-message')).toHaveText('Added 37 fake runs to the database.');
  await expect(page.locator('#data-stats > div').filter({ hasText: 'Removable fake runs' }).locator('strong')).toHaveText('37');
  const seeded = await (await request.get('/api/workshop/runs', { headers })).json();
  expect(seeded.totalRuns).toBe(before.totalRuns + 37);
  expect(seeded.rankedPlayers).toBe(before.rankedPlayers + 37);
  expect(seeded.recentPlayers).toBe(before.recentPlayers);
  await page.getByLabel('Number of fake runs').fill('1');
  const started = page.waitForResponse(res => new URL(res.url()).pathname === '/api/runs' && res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Start fake runs', exact: true }).click();
  expect((await started).status()).toBe(201);
  await page.getByRole('button', { name: 'Remove all fake runs', exact: true }).click();
  await expect(page.locator('#fake-run-progress')).toHaveAttribute('data-phase', 'stopped');
  await expect(page.locator('#data-message')).toContainText('Removed 38 fake runs');
  await expect(page.locator('#data-stats > div').filter({ hasText: 'Removable fake runs' }).locator('strong')).toHaveText('0');
  const after = await (await request.get('/api/workshop/runs', { headers })).json();
  expect(after.totalRuns).toBe(before.totalRuns);
  expect(after.protectedRuns).toBe(before.protectedRuns);
  expect(await (await request.get(`/api/runs/${human.id}`)).json()).toMatchObject({ alias: 'Keep this player', distance: 500, fakeSource: null });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#data-heading').scrollIntoViewIfNeeded();
  expect(await page.locator('#lab').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/fake-data-mobile.png' });
});
