import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const headers = { 'X-Workshop-Token': process.env.WORKSHOP_TOKEN ?? 'local-workshop' };
test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/workshop/reset', { headers })).ok()).toBeTruthy();
});
async function ready(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#network')).toBeHidden();
  await expect(page.locator('#leaderboard-overlay')).toBeHidden();
}
async function register(page: Page, alias = 'Robot pilot'): Promise<void> {
  await page.getByLabel('Name', { exact: true }).fill(alias);
  await page.getByLabel('Nationality', { exact: true }).selectOption('AT');
  await page.getByRole('button', { name: 'Start running' }).click();
  await expect(page.locator('#profile')).toBeHidden();
  await expect(page.locator('#network')).toBeHidden();
}
async function autoplay(page: Page): Promise<void> {
  await page.locator('#open-lab').click();
  await page.getByRole('textbox', { name: 'Instructor token' }).fill(headers['X-Workshop-Token']);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('#lab-controls')).toBeVisible();
  await page.getByLabel('Autoplay the next run').check();
  await page.getByRole('button', { name: 'Close Instructor Settings' }).click();
}
const distance = async (page: Page) => Number((await page.locator('#distance').textContent())?.replace(/,/g, ''));

test('shows the robot logo, registration and Instructor Settings on the simplified page', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 852 });
  await ready(page);
  await expect(page).toHaveTitle('Slop Jumpers');
  await expect(page.getByRole('heading', { name: 'Slop Jumpers', exact: true })).toBeVisible();
  const logo = page.getByRole('link', { name: 'Slop Jumpers home' }).locator('img');
  await expect(logo).toBeVisible();
  await expect.poll(() => logo.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: /How to play|Finish run/i })).toHaveCount(0);
  await expect(page.locator('#help, .level-card, .activity-card, .trail-note')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Previous runs' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Leaderboard' })).toBeVisible();
  await page.getByRole('button', { name: 'Instructor Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Instructor Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Close Instructor Settings' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('the rename preserves the saved player and unconfirmed progress', async ({ page, request }) => {
  const playerId = crypto.randomUUID();
  const alias = 'Returning robot';
  const start = await request.post('/api/runs', { data: { playerId, alias, nationalityCode: 'AT' } });
  expect(start.status()).toBe(201);
  const { id: runId } = await start.json();
  const progress = { distance: 1500, tokens: 5, elapsedMs: 22500 };
  await page.addInitScript(({ playerId, runId, progress }) => {
    localStorage.setItem('slop-jumper.player', playerId);
    localStorage.setItem('slop-jumper.outbox.v1', JSON.stringify([{ runId, checkpoint: 1, progress }]));
  }, { playerId, runId, progress });

  await ready(page);
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(alias);
  expect(await page.evaluate(() => localStorage.getItem('slop-jumpers.player'))).toBe(playerId);
  await expect(page.locator('#save-warning')).toBeVisible();

  await page.getByRole('button', { name: 'Retry saves' }).click();
  await expect(page.locator('#history')).toContainText('1,500 m');
  expect(await (await request.get(`/api/runs/${runId}`)).json()).toMatchObject({ ...progress, playerId });
  expect(await page.evaluate(() => localStorage.getItem('slop-jumpers.outbox.v1'))).toBe('[]');

  await page.reload();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(alias);
  await expect(page.locator('#save-warning')).toBeHidden();
});

test('a whitespace-only name can be corrected before starting', async ({ page }) => {
  await ready(page);
  await page.getByLabel('Name', { exact: true }).fill('   ');
  await page.getByLabel('Nationality', { exact: true }).selectOption('AT');
  await page.getByRole('button', { name: 'Start running' }).click();

  await expect(page.locator('#nickname')).toHaveJSProperty('validationMessage', 'Enter a name with at least one visible character.');
  await expect(page.locator('#profile')).toBeVisible();
  await expect(page.locator('#network')).toBeHidden();

  await register(page, 'Ready to run');
  await expect(page.locator('#trail')).toBeFocused();
});

test('an older history response cannot hide a newly saved start', async ({ page }) => {
  let sendOldHistory!: () => void;
  const held = new Promise<void>(resolve => { sendOldHistory = resolve; });
  let reads = 0;
  await page.route(/\/api\/runs\?playerId=/, async route => {
    if (++reads === 1) {
      await held;
      await route.fulfill({ json: [] });
    } else {
      await route.continue();
    }
  });

  await ready(page);
  await register(page, 'History pilot');
  await expect(page.locator('#history')).toContainText('Started');

  const oldResponse = page.waitForResponse(response =>
    response.url().includes('/api/runs?playerId=') && response.status() === 200);
  sendOldHistory();
  await (await oldResponse).finished();
  // Let the page handle the completed response before checking which history it rendered.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('#history')).toContainText('Started');
});

test('identifies the fatal slop in the result, history and ranking', async ({ page, request }) => {
  const alias = `Pilot ${crypto.randomUUID().slice(0, 8)}`;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await ready(page);
  await page.screenshot({ path: 'test-results/robot-registration.png', fullPage: true });
  await page.getByRole('button', { name: 'Start running' }).click();
  await expect(page.locator('#profile')).toBeVisible();
  await register(page, alias);
  await expect(page.locator('#finish-overlay')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#finish-hit')).toHaveText('Hit Seven-Finger Hand');
  await expect(page.locator('#finish-detail')).toContainText('two bonus fingers');
  await expect(page.locator('#finish-detail')).toContainText('1 token');
  expect(await distance(page)).toBeLessThan(180);
  await expect(page.locator('#lives')).toHaveAttribute('aria-label', '0 lives');
  await expect(page.locator('#history')).toContainText('Hit Seven-Finger Hand');
  await expect.poll(async () => {
    const board = await (await request.get('/api/leaderboard')).json();
    return board.entries.find((entry: { alias: string }) => entry.alias === alias);
  }).toMatchObject({ finished: true, collisionId: 'seven-finger-hand' });
  await page.locator('#again').click();
  await expect(page.locator('#profile')).toBeVisible();
  await expect(page.locator('#nickname')).toHaveValue(alias);
  await expect(page.locator('#nationality')).toHaveValue('AT');
  await expect(page.locator('#distance')).toHaveText('0');
  expect(errors).toEqual([]);
});

test('start is visible immediately and restart and reload fetch the latest saved profile', async ({ page, request }) => {
  await ready(page);
  const started = page.waitForResponse(response => response.url().endsWith('/api/runs') && response.request().method() === 'POST');
  await register(page);
  const run = await (await started).json();
  await expect(page.locator('#history')).toContainText('0 m');
  await expect(page.locator('#history')).toContainText('Started');
  const saved = await (await request.get(`/api/runs/${run.id}`)).json();
  expect(saved.distance).toBe(0);
  expect(saved.finished).toBe(false);
  // A newer server-side start proves restart queries the database instead of reusing form values.
  const updated = await request.post('/api/runs', { data: { playerId: run.playerId, alias: 'Server pilot', nationalityCode: 'DE' } });
  expect(updated.status()).toBe(201);
  let profileReads = 0;
  await page.route(`**/api/players/${run.playerId}/profile`, async route => {
    profileReads++;
    if (profileReads === 1) {
      await route.fulfill({ status: 503, json: { message: 'Profile temporarily unavailable.' } });
    } else {
      await route.continue();
    }
  });
  await page.locator('#restart').click();
  await expect(page.locator('#network-title')).toHaveText('Registration unavailable');
  await expect(page.locator('#profile')).toBeVisible();
  await page.locator('#network-retry').click();
  await expect(page.locator('#network')).toBeHidden();
  expect(profileReads).toBe(2);
  await expect(page.locator('#nickname')).toHaveValue('Server pilot');
  await expect(page.locator('#nationality')).toHaveValue('DE');
  // An edited profile is saved with the next start and survives a page reload at zero distance.
  await page.getByLabel('Name', { exact: true }).fill('My next robot');
  await page.getByLabel('Nationality', { exact: true }).selectOption('CH');
  const nextStart = page.waitForResponse(response => response.url().endsWith('/api/runs') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Start running' }).click();
  expect((await nextStart).status()).toBe(201);
  await page.reload();
  await expect(page.locator('#network')).toBeHidden();
  expect(profileReads).toBe(3);
  await expect(page.locator('#nickname')).toHaveValue('My next robot');
  await expect(page.locator('#nationality')).toHaveValue('CH');
  await expect(page.locator('#history')).toContainText('Started');
});

test('level loading still pauses play independently of leaderboard refresh and retries a failed level', async ({ page, request }) => {
  await ready(page);
  await autoplay(page);
  let levelRequests = 0;
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/levels/2', async route => {
    levelRequests++;
    if (levelRequests === 1) {
      await held;
      await route.fulfill({ status: 503, json: { message: 'Level unavailable' } });
    } else {
      await route.continue();
    }
  });
  const started = page.waitForResponse(response => response.url().endsWith('/api/runs') && response.request().method() === 'POST');
  await register(page);
  const run = await (await started).json();
  await expect.poll(() => distance(page)).toBeGreaterThan(80);
  expect(levelRequests).toBe(0);
  await expect(page.locator('#network-title')).toHaveText('Loading level 2..', { timeout: 35000 });
  await expect(page.locator('#distance')).toHaveText('1,500');
  await expect.poll(async () => (await (await request.get(`/api/runs/${run.id}`)).json()).distance).toBe(1500);
  await page.waitForTimeout(350);
  expect(await distance(page)).toBe(1500);
  release();
  await expect(page.locator('#network-title')).toHaveText('Level load failed');
  // Let the next automatic leaderboard refresh complete; it must not release the failed level.
  await page.waitForTimeout(10000);
  await expect(page.locator('#network')).toBeVisible();
  expect(await distance(page)).toBe(1500);
  await page.locator('#network-retry').click();
  await expect(page.locator('#network')).toBeHidden();
  await expect(page.locator('#level-label')).toHaveText('LEVEL 02');
  await expect.poll(() => distance(page)).toBeGreaterThan(1550);
  await page.screenshot({ path: 'test-results/robot-gameplay.png', fullPage: true });
});

test('10-second refresh and failures only cover the leaderboard while play and controls remain usable', async ({ page }) => {
  await ready(page);
  await autoplay(page);
  await register(page);
  let count = 0;
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/leaderboard', async route => {
    count++;
    if (count === 1) {
      await held;
      await route.fulfill({ status: 503, json: { message: 'Leaderboard queue is full.' } });
    } else {
      await route.continue();
    }
  });
  await expect(page.locator('#leaderboard-overlay')).toBeVisible({ timeout: 12000 });
  await expect(page.locator('#leaderboard-title')).toHaveText('Refreshing leaderboard..');
  await expect(page.locator('#network')).toBeHidden();
  expect(await page.locator('main').evaluate(element => element.inert)).toBe(false);
  expect(await page.locator('#leaderboard-content').evaluate(element => element.inert)).toBe(true);
  await expect(page.locator('#leaderboard-panel')).toHaveAttribute('aria-busy', 'true');
  const beforeRefresh = await distance(page);
  await expect.poll(() => distance(page)).toBeGreaterThan(beforeRefresh + 25);
  expect(count).toBe(1);
  release();
  await expect(page.locator('#leaderboard-title')).toHaveText('Refresh failed');
  await expect(page.locator('#leaderboard-panel')).toHaveAttribute('aria-busy', 'false');
  const beforeFailure = await distance(page);
  await expect.poll(() => distance(page)).toBeGreaterThan(beforeFailure + 25);
  await page.locator('#refresh-history').click();
  await page.locator('#restart').click();
  await expect(page.locator('#profile')).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Still playable');
  await page.screenshot({ path: 'test-results/leaderboard-only-failure.png', fullPage: true });
  // The failed card waits for explicit retry without blocking registration or automatic game work.
  await page.waitForTimeout(11000);
  expect(count).toBe(1);
  await expect(page.locator('#network')).toBeHidden();
  await expect(page.locator('#leaderboard-overlay')).toBeVisible();
  await page.locator('#leaderboard-retry').click();
  await expect(page.locator('#leaderboard-overlay')).toBeHidden();
  expect(await page.locator('#leaderboard-content').evaluate(element => element.inert)).toBe(false);
  await expect(page.locator('#nickname')).toHaveValue('Still playable');
});

test('level save confirmation survives reload and retry is idempotent', async ({ page, request }) => {
  await request.put('/api/workshop/scenario', { headers, data: { loseConfirmation: true } });
  await ready(page);
  await autoplay(page);
  await register(page);
  await expect(page.locator('#retry')).toBeVisible({ timeout: 35000 });
  const first = JSON.parse(await page.evaluate(() => localStorage.getItem('slop-jumpers.outbox.v1')!))[0];
  expect((await (await request.get(`/api/runs/${first.runId}`)).json()).distance).toBe(1500);
  await page.reload();
  await expect(page.locator('#network')).toBeHidden();
  await expect(page.locator('#retry')).toBeVisible();
  await page.locator('#retry').click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('slop-jumpers.outbox.v1'))).toBe('[]');
});

test('instructor 502 percentage affects real game requests and remains recoverable at 100 percent', async ({ page, request }) => {
  expect((await request.post('/api/workshop/seed', { headers, data: { count: 12 } })).ok()).toBeTruthy();
  test.setTimeout(60000);
  await ready(page);
  await autoplay(page);
  await page.locator('#open-lab').click();
  await page.getByLabel('Number of fake runs').fill('2');
  await page.getByRole('button', { name: 'Start fake runs', exact: true }).click();
  await expect(page.locator('#fake-run-progress')).toHaveAttribute('data-started', '2');
  await page.getByLabel('Request failures (%)').fill('25');
  await page.getByRole('button', { name: 'Apply failure rate' }).click();
  await expect(page.locator('#failure-status')).toContainText('25%');
  expect((await (await request.get('/api/workshop', { headers })).json()).scenario.requestFailurePercent).toBe(25);
  await page.getByLabel('Request failures (%)').fill('100');
  await page.getByRole('button', { name: 'Apply failure rate' }).click();
  await expect(page.locator('#failure-status')).toContainText('100%');
  await page.getByRole('button', { name: 'Close Instructor Settings' }).click();
  // This is a real backend HTTP 502, with no browser route interception.
  expect((await request.get('/api/leaderboard')).status()).toBe(502);
  expect((await request.get('/api/levels/1')).status()).toBe(502);
  await expect(page.locator('#leaderboard-title')).toHaveText('Refresh failed', { timeout: 12000 });
  await expect(page.locator('#leaderboard-detail')).toContainText('The server is currently unavailable.');
  await expect(page.locator('#leaderboard-detail')).not.toContainText('HTTP 502');
  await expect(page.locator('#network')).toBeHidden();
  await page.getByLabel('Name', { exact: true }).fill('Traffic pilot');
  await page.getByLabel('Nationality', { exact: true }).selectOption('AT');
  await page.locator('#open-lab').click();
  await page.getByLabel('Request failures (%)').fill('0');
  await page.getByRole('button', { name: 'Apply failure rate' }).click();
  await expect(page.locator('#failure-status')).toHaveText('HTTP 502 fault is off.');
  await page.screenshot({ path: 'test-results/request-failure-control.png' });
  await page.getByRole('button', { name: 'Close Instructor Settings' }).click();
  await page.locator('#recover-traffic').click();
  await expect(page.locator('#leaderboard-overlay')).toBeHidden({ timeout: 15000 });
  await expect(page.locator('#fake-run-progress')).toHaveAttribute('data-phase', 'stopped');
  await expect(page.locator('#network')).toBeHidden();
  await expect(page.locator('#nickname')).toHaveValue('Traffic pilot');
  const response = await request.get('/api/leaderboard');
  expect(response.status()).toBe(200);
  const leaderboard = await response.json();
  expect(leaderboard.entries.length).toBeGreaterThan(8);
  await expect(page.locator('#records li')).toHaveCount(8);

  // A fresh page at 100% cannot load registration, but the overlay still opens the lab.
  await page.locator('#open-lab').click();
  await page.getByLabel('Request failures (%)').fill('100');
  await page.getByRole('button', { name: 'Apply failure rate' }).click();
  await expect(page.locator('#failure-status')).toContainText('100%');
  await page.reload();
  await expect(page.locator('#network-retry')).toBeVisible();
  await page.locator('#network-lab').click();
  await page.getByRole('textbox', { name: 'Instructor token' }).fill(headers['X-Workshop-Token']);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('#failure-status')).toContainText('100%');
  await page.getByLabel('Request failures (%)').fill('0');
  await page.getByRole('button', { name: 'Apply failure rate' }).click();
  await expect(page.locator('#failure-status')).toHaveText('HTTP 502 fault is off.');
  await page.getByRole('button', { name: 'Close Instructor Settings' }).click();
  await page.locator('#network-retry').click();
  await expect(page.locator('#network')).toBeHidden();
  await page.locator('#leaderboard-retry').click();
  await expect(page.locator('#leaderboard-overlay')).toBeHidden();
});

test('instructor can resize the real database pool and restore it during fake traffic and faults', async ({ page, request }) => {
  await ready(page);
  await autoplay(page);
  await page.locator('#open-lab').click();
  const initial = (await (await request.get('/api/workshop', { headers })).json()).database;
  await expect(page.getByLabel('Database connections')).toHaveValue(String(initial.defaultConnections));
  await page.getByLabel('Database connections').fill('1');
  await page.getByRole('button', { name: 'Apply limit', exact: true }).click();
  await expect(page.locator('#database-status')).toContainText('Up to 1 database connection');
  expect((await (await request.get('/api/workshop', { headers })).json()).database.maxConnections).toBe(1);
  await page.getByLabel('Number of fake runs').fill('2');
  await page.getByRole('button', { name: 'Start fake runs', exact: true }).click();
  await expect(page.locator('#fake-run-progress')).toHaveAttribute('data-started', '2');
  await page.getByLabel('Request failures (%)').fill('100');
  await page.getByRole('button', { name: 'Apply failure rate' }).click();
  await expect(page.locator('#failure-status')).toContainText('100%');
  await page.getByRole('button', { name: 'Restore default', exact: true }).click();
  await expect(page.getByLabel('Database connections')).toHaveValue(String(initial.defaultConnections));
  const restored = await (await request.get('/api/workshop', { headers })).json();
  expect(restored.database.maxConnections).toBe(initial.defaultConnections);
  expect(restored.scenario.requestFailurePercent).toBe(100);
  await expect(page.locator('#fake-run-progress')).toHaveAttribute('data-phase', 'running');
  await page.getByRole('button', { name: 'Normal traffic', exact: true }).click();
  await expect(page.locator('#failure-status')).toHaveText('HTTP 502 fault is off.');
  await expect(page.locator('#fake-run-progress')).toHaveAttribute('data-phase', 'stopped');
  await page.getByLabel('Database connections').fill('0');
  await page.getByRole('button', { name: 'Apply limit', exact: true }).click();
  expect((await (await request.get('/api/workshop', { headers })).json()).database.maxConnections).toBe(initial.defaultConnections);
  await page.getByLabel('Database connections').fill('1');
  await page.getByRole('button', { name: 'Apply limit', exact: true }).click();
  await expect(page.locator('#database-status')).toContainText('Up to 1 database connection');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Database connections').scrollIntoViewIfNeeded();
  expect(await page.locator('#lab').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/database-capacity-mobile.png' });
  await page.getByRole('button', { name: 'Reset faults and stop traffic', exact: true }).click();
  await expect(page.getByLabel('Database connections')).toHaveValue(String(initial.defaultConnections));
});

test('player activity updates on the main page and recovers independently from a failed count', async ({ page, request }) => {
  await ready(page);
  const before = (await (await request.get('/api/activity')).json()).players;
  await expect(page.locator('#player-count')).toHaveText(String(before));
  const playerId = crypto.randomUUID();
  for (let i = 0; i < 2; i++) {
    expect((await request.post('/api/runs', { data: { playerId, alias: 'Activity pilot', nationalityCode: 'AT' } })).status()).toBe(201);
  }
  await expect(page.locator('#player-count')).toHaveText(String(before + 1), { timeout: 12000 });
  await page.route('**/api/activity', route => route.fulfill({ status: 502, json: { message: 'Internal fault.request_failure HTTP 502' } }));
  await expect(page.locator('#player-count')).toHaveText('—', { timeout: 12000 });
  await expect(page.locator('#player-activity-status')).toHaveText('The server is currently unavailable.');
  await expect(page.locator('#network')).toBeHidden();
  await page.getByLabel('Name', { exact: true }).fill('Still playable');
  await page.unroute('**/api/activity');
  await expect(page.locator('#player-count')).toHaveText(String(before + 1), { timeout: 12000 });
  await expect(page.locator('#player-activity-status')).toBeEmpty();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/player-activity-mobile.png', fullPage: true });
});

test('mobile registration fits, touch jumps, and restart during play saves the run', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.route('**/api/leaderboard', route => route.fulfill({ status: 503, json: { message: 'Unavailable' } }));
  await page.locator('#refresh-leaderboard').click();
  await expect(page.locator('#leaderboard-title')).toHaveText('Refresh failed');
  const panel = (await page.locator('#leaderboard-panel').boundingBox())!;
  const overlay = (await page.locator('#leaderboard-overlay').boundingBox())!;
  expect(overlay.x).toBeGreaterThanOrEqual(panel.x);
  expect(overlay.y).toBeGreaterThanOrEqual(panel.y);
  expect(overlay.x + overlay.width).toBeLessThanOrEqual(panel.x + panel.width);
  expect(overlay.y + overlay.height).toBeLessThanOrEqual(panel.y + panel.height);
  await page.screenshot({ path: 'test-results/leaderboard-only-mobile.png', fullPage: true });
  await register(page);
  await page.locator('#trail').click({ position: { x: 180, y: 220 } });
  await expect(page.locator('#game-hud')).toBeVisible();
  await page.locator('#restart').click();
  await expect(page.locator('#profile')).toBeVisible();
  await expect(page.locator('#nickname')).toHaveValue('Robot pilot');
  await expect(page.locator('#nationality')).toHaveValue('AT');
  await expect(page.locator('#history')).toContainText('Finished');
});

test('leaderboard displays only the first eight entries and treats names as text', async ({ page }) => {
  await page.route('**/api/leaderboard', route => route.fulfill({ json: {
    generatedAt: Date.now(),
    entries: [{ alias: '<img src=x>', distance: 1234, tokens: 12, finished: true, collisionId: 'vibe-coded-toaster', nationality: { code: 'AT', name: 'Austria' } }, ...Array.from({ length: 11 }, (_, index) => ({ alias: `Pilot ${index + 2}`, distance: 1200 - index, tokens: 10, nationality: { code: 'AT', name: 'Austria' } }))],
  } }));
  await page.goto('/');
  await expect(page.locator('#network')).toBeHidden();
  await expect(page.locator('#records')).toContainText('<img src=x>');
  await expect(page.locator('#records')).toContainText('Austria');
  await expect(page.locator('#records li').first()).toContainText('Hit Vibe-Coded Toaster');
  await expect(page.locator('#records li').first()).toContainText('⬢ 12 tokens');
  await expect(page.locator('#records img')).toHaveCount(0);
  await expect(page.locator('#records li')).toHaveCount(8);
  await expect(page.locator('#records li').last()).toContainText('Pilot 8');
  await expect(page.locator('#records')).not.toContainText('Pilot 9');
});
