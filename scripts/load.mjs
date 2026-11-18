#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { randomUUID, randomInt } from 'node:crypto';
import names from '../shared/fake-names.json' with { type: 'json' };

const { values } = parseArgs({ options: {
  rate: { type: 'string', default: '12' }, seconds: { type: 'string', default: '20' },
  profile: { type: 'string', default: 'leaderboard' }, players: { type: 'string', default: '12' },
} });
const rate = Number(values.rate);
const seconds = Number(values.seconds);
const playerCount = Number(values.players);
if (!Number.isFinite(rate) || rate < 1 || rate > 50 || !Number.isFinite(seconds) || seconds < 1 || seconds > 120 ||
    !Number.isInteger(playerCount) || playerCount < 1 || playerCount > 32 || !['leaderboard', 'mixed'].includes(values.profile)) {
  throw new Error('Bounds: --rate 1..50 --seconds 1..120 --players 1..32 --profile leaderboard|mixed');
}
const base = process.env.DEMO_URL ?? 'http://127.0.0.1:8090';
const token = process.env.WORKSHOP_TOKEN ?? 'local-workshop';
const players = [];
const aliases = names.givenNames.flatMap(first => names.familyNames.map(last => `${first} ${last}`));
if (values.profile === 'mixed') {
  for (let i = 0; i < playerCount; i++) {
    const response = await fetch(`${base}/api/runs`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Workshop-Token': token },
      body: JSON.stringify({ alias: aliases.splice(randomInt(aliases.length), 1)[0], playerId: randomUUID(), nationalityCode: ['AT', 'DE', 'CH', 'IT'][i % 4], fake: true }), signal: AbortSignal.timeout(6500) });
    if (!response.ok) {
      throw new Error(`Could not prepare load player: HTTP ${response.status}`);
    }
    players.push({ id: (await response.json()).id, checkpoint: 0, busy: false, finished: false, target: randomInt(1, 8001) });
  }
}
const results = [];
const inFlight = new Set();
let offered = 0;
let skipped = 0;
let interrupted = false;
let writeIndex = 0;
process.on('SIGINT', () => { interrupted = true; });
const start = performance.now();
const startedAt = new Date().toISOString();

function issue(sequence) {
  let player;
  let path = '/leaderboard';
  let payload;
  if (values.profile === 'mixed' && sequence % 4 === 0) {
    const remaining = players.filter(candidate => !candidate.finished);
    player = remaining.length ? remaining[writeIndex++ % remaining.length] : undefined;
    if (player?.busy) {
      skipped++;
      return;
    }
    if (player) {
      player.busy = true;
      player.checkpoint++;
      const distance = Math.min(player.target, player.checkpoint * 1500);
      player.finished = distance === player.target;
      path = player.finished ? `/runs/${player.id}/finish` : `/runs/${player.id}/checkpoints/${player.checkpoint}`;
      payload = { distance, tokens: Math.floor(distance / 90), elapsedMs: distance * 20 };
    }
  }
  const began = performance.now();
  const operation = player ? 'checkpoint' : 'leaderboard';
  const task = fetch(`${base}/api${path}`, {
    method: player ? 'PUT' : 'GET', headers: { 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(6500),
  }).then(async response => {
    await response.arrayBuffer();
    results.push({ operation, status: response.status, ms: performance.now() - began });
  }).catch(() => {
    results.push({ operation, status: 0, ms: performance.now() - began });
  }).finally(() => {
    if (player) {
      player.busy = false;
    }
    inFlight.delete(task);
  });
  inFlight.add(task);
}

// Arrival timing is independent of responses. Capacity is bounded and skips are reported.
while (!interrupted && offered < Math.ceil(rate * seconds) && performance.now() - start < seconds * 1000) {
  const scheduled = offered * 1000 / rate;
  const wait = scheduled - (performance.now() - start);
  if (wait > 0) {
    await new Promise(resolve => setTimeout(resolve, wait));
  }
  if (performance.now() - start >= seconds * 1000) {
    break;
  }
  offered++;
  if (inFlight.size >= 64) {
    skipped++;
  } else {
    issue(offered);
  }
}
await Promise.allSettled([...inFlight]);
const summarize = (items) => {
  const durations = items.map(item => item.ms).sort((a, b) => a - b);
  const percentile = (q) => durations.length ? Math.round(durations[Math.min(durations.length - 1, Math.ceil(durations.length * q) - 1)]) : null;
  return { requests: items.length, statuses: Object.fromEntries([...new Set(items.map(item => item.status))].map(status => [status, items.filter(item => item.status === status).length])), p50Ms: percentile(.5), p95Ms: percentile(.95), maxMs: durations.length ? Math.round(durations.at(-1)) : null };
};
console.log(JSON.stringify({ base, startedAt, rate, seconds, profile: values.profile, offered, skipped,
  elapsedSeconds: Number(((performance.now() - start) / 1000).toFixed(2)),
  total: summarize(results), leaderboard: summarize(results.filter(item => item.operation === 'leaderboard')),
  checkpoints: summarize(results.filter(item => item.operation === 'checkpoint')),
  note: 'Synthetic API arrivals, not rendered players. Percentiles include failed responses; HTTP 0 means client/network failure. Mixed traffic adds marked fake runs up to 8,000 m; completed players are not replaced. No automatic retries.',
}, null, 2));
