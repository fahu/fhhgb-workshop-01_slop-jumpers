import { request, errorMessage } from '../api';
import { el, text } from '../dom';
import type { RunCounts, Workshop } from '../types';
import { FakeRuns } from './fake-runs';

interface WorkshopEvents {
  dataChanged: () => void;
  dialogChanged: (open: boolean) => void;
  trafficChanged: (running: boolean) => void;
  retryFailures: () => Promise<unknown>;
}

export function mountInstructorSettings(events: WorkshopEvents) {
  const instructorSettings = el<HTMLDialogElement>('lab');
  const delayButton = el<HTMLButtonElement>('request-delay');
  let randomRequestDelay = false;
  let labConnected = false;
  let dataBusy = false;
  let failureRateDirty = false;
  let databaseLimitDirty = false;

  const token = () => el<HTMLInputElement>('workshop-token').value;
  async function labAction(action: () => Promise<unknown>, message = 'Settings applied.'): Promise<void> {
    try {
      await action();
      await refreshLab();
      text('lab-message', message);
    } catch (error) {
      text('lab-message', errorMessage(error));
    }
  }
  async function refreshLab(): Promise<void> {
    const state = await request<Workshop>('/workshop', 'GET', undefined, token());
    if (!failureRateDirty) {
      el<HTMLInputElement>('failure-percent').value = String(state.scenario.requestFailurePercent);
    }
    if (!databaseLimitDirty) {
      el<HTMLInputElement>('database-connections').value = String(state.database.maxConnections);
    }
    text('database-status', `Up to ${state.database.maxConnections} database ${state.database.maxConnections === 1 ? 'connection' : 'connections'} · ${state.database.connectionTimeoutMs / 1000}s maximum wait. Default: ${state.database.defaultConnections}.`);
    el('database-stats').innerHTML = [['In use', state.database.active], ['Available', state.database.idle], ['Waiting', state.database.waiting], ['Limit', state.database.maxConnections]].map(([name, value]) => `<div><strong>${value}</strong><small>${name}</small></div>`).join('');
    text('failure-status', state.scenario.requestFailurePercent === 0 ? 'HTTP 502 fault is off.' : `HTTP 502 fault: ${state.scenario.requestFailurePercent}% chance per game API request.`);
    randomRequestDelay = state.scenario.randomRequestDelay;
    delayButton.textContent = randomRequestDelay ? 'Disable random request delay' : 'Enable random request delay';
    labConnected = true;
    el('lab-controls').hidden = false;
    el('lab-stats').innerHTML = [['Active', state.leaderboard.active], ['Queued', state.leaderboard.queued], ['Builds', state.leaderboard.builds], ['Rejected', state.leaderboard.rejected]].map(([name, value]) => `<div><strong>${value}</strong><small>${name}</small></div>`).join('');
    text('capacity-note', `${state.leaderboard.workers} workers · ${state.leaderboard.deadlineMs} ms deadline. The leaderboard displays the top eight players. Fake-run traffic uses at most 32 in-flight requests, with queued requests shown in batch progress.`);
  }
  const fakeRuns = new FakeRuns(status => {
    const running = status.phase === 'running' || status.phase === 'stopping';
    el<HTMLButtonElement>('start-fake-runs').disabled = running || dataBusy;
    el<HTMLInputElement>('fake-run-count').disabled = running || dataBusy;
    el<HTMLButtonElement>('stop-fake-runs').disabled = !running || status.phase === 'stopping';
    el('stop-traffic').hidden = !running;
    el('traffic-banner').hidden = status.requested === 0;
    const label = status.phase === 'finished' ? 'Batch finished' : status.phase === 'stopped' ? 'Batch stopped' : status.phase === 'stopping' ? 'Stopping fake runs' : 'Fake runs';
    const summary = `${label}: ${status.started}/${status.requested} started · ${status.active} active · ${status.completed} completed · ${status.failed} failed · ${status.cancelled} cancelled`;
    text('traffic-summary', summary);
    text('fake-run-progress', `${summary}. ${status.requests} requests · ${status.requestErrors} request errors · ${status.inFlight} in flight · ${status.queued} queued.`);
    el('fake-run-progress').dataset.phase = status.phase;
    el('fake-run-progress').dataset.completed = String(status.completed);
    el('fake-run-progress').dataset.started = String(status.started);
    text('fake-run-error', status.lastError ? `Last request/run error: ${status.lastError}` : '');
    if (!running && !dataBusy && labConnected) {
      void refreshRunCounts();
    }
    events.trafficChanged(running);
  });

  async function refreshRunCounts(): Promise<void> {
    text('data-count-status', 'Loading database counts…');
    try {
      const counts = await request<RunCounts>('/workshop/runs', 'GET', undefined, token());
      el('data-stats').innerHTML = [
        ['Stored runs', counts.totalRuns], ['Ranked players', counts.rankedPlayers],
        ['Players · last 30 min', counts.recentPlayers], ['Runs at 0 m', counts.startedOnlyRuns],
        ['Removable fake runs', counts.removableFakeRuns], ['Protected runs', counts.protectedRuns],
      ].map(([name, value]) => `<div><strong>${Number(value).toLocaleString()}</strong><small>${name}</small></div>`).join('');
      text('data-count-status', `Counts updated at ${new Date().toLocaleTimeString()}. Refresh to include ongoing traffic.`);
    } catch (error) {
      text('data-count-status', `Counts could not be updated: ${errorMessage(error)}`);
    }
  }

  async function changeRunData(action: () => Promise<string>): Promise<void> {
    if (dataBusy) {
      return;
    }
    dataBusy = true;
    for (const id of ['seed-runs', 'seed-count', 'remove-fake-runs', 'refresh-data', 'start-fake-runs', 'fake-run-count']) {
      el<HTMLButtonElement>(id).disabled = true;
    }
    text('data-message', 'Updating stored runs…');
    try {
      text('data-message', await action());
      await refreshRunCounts();
      events.dataChanged();
    } catch (error) {
      text('data-message', `${errorMessage(error)} Refresh counts before trying again; an interrupted response may still have saved the change.`);
    } finally {
      dataBusy = false;
      for (const id of ['seed-runs', 'seed-count', 'remove-fake-runs', 'refresh-data']) {
        el<HTMLButtonElement>(id).disabled = false;
      }
      el<HTMLButtonElement>('start-fake-runs').disabled = fakeRuns.running;
      el<HTMLInputElement>('fake-run-count').disabled = fakeRuns.running;
    }
  }

  async function stopTrafficAndDrain(): Promise<void> {
    fakeRuns.stop();
    // Cancellation releases browser connections. Already accepted server jobs still need to drain.
    const deadline = performance.now() + 6000;
    while (true) {
      const state = await request<Workshop>('/workshop', 'GET', undefined, token());
      if (state.leaderboard.active === 0 && state.leaderboard.queued === 0) {
        break;
      }
      if (performance.now() >= deadline) {
        throw new Error('Other traffic is still active. Stop it and retry.');
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }

  function openInstructorSettings(): void {
    instructorSettings.showModal();
    events.dialogChanged(true);
  }

  el('open-lab').addEventListener('click', openInstructorSettings);
  el('network-lab').addEventListener('click', openInstructorSettings);
  el('close-lab').addEventListener('click', () => instructorSettings.close());
  instructorSettings.addEventListener('close', () => events.dialogChanged(false));
  el('connect-lab').addEventListener('click', () => void labAction(async () => {
    await refreshLab();
    await refreshRunCounts();
  }));
  el('workshop-token').addEventListener('input', () => { labConnected = false; el('lab-controls').hidden = true; });
  document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(button => button.addEventListener('click', () => void labAction(async () => {
    const preset = button.dataset.preset;
    if (preset === 'healthy') {
      await request('/workshop/reset', 'POST', {}, token());
      databaseLimitDirty = false;
    } else {
      await request('/workshop/scenario', 'PUT', { loseConfirmation: true, requestFailurePercent: 0 }, token());
    }
    failureRateDirty = false;
    fakeRuns.stop();
  }, 'Scenario applied. Any active fake-run batch is stopped.')));
  el('database-connections').addEventListener('input', () => { databaseLimitDirty = true; });
  el('database-form').addEventListener('submit', event => {
    event.preventDefault();
    const input = el<HTMLInputElement>('database-connections');
    if (!input.reportValidity()) {
      return;
    }
    const maxConnections = input.valueAsNumber;
    void labAction(async () => {
      await request('/workshop/database', 'PUT', { maxConnections }, token());
      databaseLimitDirty = false;
    }, 'Database limit applied. Current queries can finish before excess connections close.');
  });
  el('restore-database').addEventListener('click', () => void labAction(async () => {
    await request('/workshop/database/reset', 'POST', {}, token());
    databaseLimitDirty = false;
  }, 'Default database capacity restored.'));
  el('failure-percent').addEventListener('input', () => { failureRateDirty = true; });
  el('failure-form').addEventListener('submit', event => {
    event.preventDefault();
    const input = el<HTMLInputElement>('failure-percent');
    if (!input.reportValidity()) {
      return;
    }
    const percent = input.valueAsNumber;
    void labAction(async () => {
      await request('/workshop/scenario', 'PATCH', { requestFailurePercent: percent }, token());
      failureRateDirty = false;
    }, percent === 0 ? 'HTTP 502 fault disabled. Retry any failed game requests.' : `HTTP 502 fault enabled for ${percent}% of game API requests on average.`);
  });
  delayButton.addEventListener('click', async () => {
    const enabled = !randomRequestDelay;
    delayButton.disabled = true;
    try {
      await labAction(() => request('/workshop/scenario', 'PATCH', { randomRequestDelay: enabled }, token()),
        enabled ? 'Random request delay enabled for all API endpoints.' : 'Random request delay disabled.');
    } finally {
      delayButton.disabled = false;
    }
  });
  el('fake-run-form').addEventListener('submit', event => {
    event.preventDefault();
    const count = el<HTMLInputElement>('fake-run-count');
    if (!count.reportValidity()) {
      return;
    }
    try {
      fakeRuns.start(count.valueAsNumber, token());
      text('lab-message', 'Fake runs are driven by this browser. Close Instructor Settings to watch the game while they run.');
    } catch (error) {
      text('lab-message', errorMessage(error));
    }
  });
  el('refresh-data').addEventListener('click', () => void refreshRunCounts());
  el('seed-form').addEventListener('submit', event => {
    event.preventDefault();
    const input = el<HTMLInputElement>('seed-count');
    if (!input.reportValidity()) {
      return;
    }
    const count = input.valueAsNumber;
    void changeRunData(async () => {
      const result = await request<{ added: number }>('/workshop/seed', 'POST', { count }, token());
      return `Added ${result.added.toLocaleString()} fake runs to the database.`;
    });
  });
  el('remove-fake-runs').addEventListener('click', () => void changeRunData(async () => {
    await fakeRuns.stopAndWait();
    const removed = await request<{ runs: number; checkpoints: number }>('/workshop/fake-runs', 'DELETE', undefined, token());
    return `Removed ${removed.runs.toLocaleString()} fake runs and ${removed.checkpoints.toLocaleString()} checkpoints. Protected runs were kept.`;
  }));
  el('stop-fake-runs').addEventListener('click', () => fakeRuns.stop());
  el('stop-traffic').addEventListener('click', () => fakeRuns.stop());
  el('reset').addEventListener('click', () => void labAction(async () => {
    fakeRuns.stop();
    await request('/workshop/reset', 'POST', {}, token());
    databaseLimitDirty = false;
    failureRateDirty = false;
    await events.retryFailures();
  }));

  setInterval(() => {
    if (labConnected && instructorSettings.open) {
      void refreshLab().catch((error: unknown) => text('lab-message', errorMessage(error)));
    }
  }, 1000);

  return {
    autoplay: () => el<HTMLInputElement>('autoplay').checked,
    stopTrafficAndDrain,
  };
}
