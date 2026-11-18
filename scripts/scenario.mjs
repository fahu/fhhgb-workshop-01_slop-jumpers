#!/usr/bin/env node
const base = process.env.DEMO_URL ?? 'http://127.0.0.1:8090';
const token = process.env.WORKSHOP_TOKEN ?? 'local-workshop';
const [command = 'status', value] = process.argv.slice(2);
const scenarios = {
  healthy: {},
  lost: { loseConfirmation: true },
};
let path = '/workshop';
let method = 'GET';
let data;
if (command in scenarios) {
  path = '/workshop/scenario';
  method = 'PUT';
  data = { loseConfirmation: false, requestFailurePercent: 0, ...scenarios[command] };
} else if (command === 'reset') {
  path = '/workshop/reset';
  method = 'POST';
  data = {};
} else if (command === 'seed') {
  const count = Number(value ?? 1000);
  if (!Number.isInteger(count) || count < 1 || count > 10000) {
    throw new Error('Seed count must be an integer between 1 and 10000.');
  }
  path = '/workshop/seed';
  method = 'POST';
  data = { count };
} else if (command !== 'status') {
  throw new Error('Use status, healthy, lost, reset, or seed [count].');
}
const response = await fetch(`${base}/api${path}`, {
  method, headers: { 'Content-Type': 'application/json', 'X-Workshop-Token': token },
  body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(30000),
});
const result = await response.json();
if (!response.ok) {
  throw new Error(`${response.status}: ${result.message}`);
}
console.log(JSON.stringify(result, null, 2));
