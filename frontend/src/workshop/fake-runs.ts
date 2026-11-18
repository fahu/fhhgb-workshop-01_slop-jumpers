import { request, errorMessage } from '../api';
import { COURSE_VERSION } from '../game/course';
import { RobotSimulation } from '../game/simulation';
import { fakeNames } from './fake-names';
import type { Level, Nationality, Obstacle, PlayerProfile, Progress, Run } from '../types';

const MAX_FAKE_DISTANCE = 8000;

export interface FakeRunStatus {
  phase: 'idle' | 'running' | 'stopping' | 'finished' | 'stopped';
  requested: number; started: number; active: number; completed: number; failed: number; cancelled: number;
  requests: number; requestErrors: number; inFlight: number; queued: number; lastError: string;
}

interface Playing {
  sim: RobotSimulation; crashAt?: Obstacle; lastStep: number; resolve: () => void; reject: (error: unknown) => void;
  signal: AbortSignal; abort: () => void;
}
interface Batch {
  token: string; done?: Promise<void>; controller: AbortController; status: FakeRunStatus; slots: RequestSlots; playing: Set<Playing>;
  tick?: ReturnType<typeof setInterval>; reporting?: ReturnType<typeof setInterval>;
}

/** Limits browser requests; required lifecycle operations wait instead of being silently skipped. */
class RequestSlots {
  active = 0;
  private waiting: { grant: () => void; reject: (error: unknown) => void; signal: AbortSignal; abort: () => void }[] = [];

  get queued(): number {
    return this.waiting.length;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter = {
        signal, reject,
        grant: () => {
          this.active++;
          resolve(() => { this.active--; this.drain(); });
        },
        abort: () => {
          this.waiting = this.waiting.filter(item => item !== waiter);
          reject(signal.reason);
        },
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.waiting.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < 32 && this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      waiter.signal.removeEventListener('abort', waiter.abort);
      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason);
      } else {
        waiter.grant();
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Runs real client lifecycles with the shared game physics, without drawing extra canvases. */
export class FakeRuns {
  private batch?: Batch;

  constructor(private changed: (status: FakeRunStatus) => void) {}

  get running(): boolean {
    return this.batch?.status.phase === 'running' || this.batch?.status.phase === 'stopping';
  }

  start(count: number, token: string): void {
    if (this.running) {
      throw new Error('Stop the current batch before starting another.');
    }
    if (!Number.isInteger(count) || count < 1 || count > 1000) {
      throw new Error('Enter a whole number of runs between 1 and 1,000.');
    }
    const batch: Batch = {
      token, controller: new AbortController(), slots: new RequestSlots(), playing: new Set(),
      status: { phase: 'running', requested: count, started: 0, active: count, completed: 0, failed: 0, cancelled: 0,
        requests: 0, requestErrors: 0, inFlight: 0, queued: 0, lastError: '' },
    };
    this.batch = batch;
    // One clock for all robots. Network waits never advance a robot into an unloaded level.
    batch.tick = setInterval(() => {
      const now = performance.now();
      for (const player of batch.playing) {
        player.sim.advance(Math.min(250, now - player.lastStep), true, player.crashAt);
        player.lastStep = now;
        if (player.sim.dead || player.sim.levelComplete) {
          batch.playing.delete(player);
          player.signal.removeEventListener('abort', player.abort);
          player.resolve();
        }
      }
    }, 50);
    batch.reporting = setInterval(() => this.publish(batch), 250);
    this.publish(batch);
    batch.done = Promise.allSettled(fakeNames(count).map(alias =>
      this.run(batch, alias, 1 + Math.floor(Math.random() * MAX_FAKE_DISTANCE))))
      .then(() => {
        clearInterval(batch.tick);
        clearInterval(batch.reporting);
        batch.status.phase = batch.controller.signal.aborted ? 'stopped' : 'finished';
        this.publish(batch);
      });
  }

  stop(): void {
    if (this.batch && this.running) {
      this.batch.status.phase = 'stopping';
      this.batch.controller.abort();
      this.publish(this.batch);
    }
  }

  async stopAndWait(): Promise<void> {
    this.stop();
    await this.batch?.done;
  }

  private publish(batch: Batch): void {
    this.changed({ ...batch.status, inFlight: batch.slots.active, queued: batch.slots.queued });
  }

  private async call<T>(batch: Batch, signal: AbortSignal, path: string, method = 'GET', body?: unknown): Promise<T> {
    const release = await batch.slots.acquire(signal);
    try {
      signal.throwIfAborted();
      batch.status.requests++;
      return await request<T>(path, method, body, path === '/runs' && method === 'POST' ? batch.token : undefined, signal);
    } catch (error) {
      if (!signal.aborted) {
        batch.status.requestErrors++;
        batch.status.lastError = errorMessage(error);
      }
      throw error;
    } finally {
      release();
    }
  }

  private async save(batch: Batch, signal: AbortSignal, path: string, progress: Progress): Promise<void> {
    // Only idempotent writes are retried, with exactly the same payload (including lost confirmations).
    for (let attempt = 0; ; attempt++) {
      try {
        await this.call(batch, signal, path, 'PUT', progress);
        return;
      } catch (error) {
        if (signal.aborted || attempt === 2) {
          throw error;
        }
        await sleep(500 * (attempt + 1), signal);
      }
    }
  }

  private async leaderboard(batch: Batch, signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        const began = performance.now();
        // Failed reads get another chance on the next refresh while the robot keeps playing.
        await Promise.allSettled([
          this.call(batch, signal, '/leaderboard'),
          this.call(batch, signal, '/activity'),
        ]);
        await sleep(Math.max(0, 10000 - (performance.now() - began)), signal);
      }
    } catch {
      // A finished/stopped robot cancels its outstanding refresh and timer.
    }
  }

  private play(batch: Batch, sim: RobotSimulation, crashAt: Obstacle | undefined, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const player: Playing = { sim, crashAt, signal, lastStep: performance.now(), resolve, reject,
        abort: () => { batch.playing.delete(player); reject(signal.reason); } };
      signal.addEventListener('abort', player.abort, { once: true });
      batch.playing.add(player);
    });
  }

  private async run(batch: Batch, alias: string, target: number): Promise<void> {
    const actor = new AbortController();
    const signal = AbortSignal.any([batch.controller.signal, actor.signal]);
    const playerId = crypto.randomUUID();
    const refresh = this.leaderboard(batch, signal);
    try {
      // Each robot opens registration and history through the same APIs as the visible client.
      const setup = await Promise.allSettled([
        this.call<Nationality[]>(batch, signal, '/nationalities'),
        this.call<PlayerProfile | undefined>(batch, signal, `/players/${playerId}/profile`),
        this.call<Run[]>(batch, signal, `/runs?playerId=${playerId}`),
      ]);
      for (const result of setup) {
        if (result.status === 'rejected') {
          throw result.reason;
        }
      }
      const countries = (setup[0] as PromiseFulfilledResult<Nationality[]>).value;
      if (countries.length === 0) {
        throw new Error('No nationalities are available.');
      }
      const nationalityCode = countries[Math.floor(Math.random() * countries.length)].code;
      const level = await this.call<Level>(batch, signal, '/levels/1');
      if (level.courseVersion !== COURSE_VERSION) {
        throw new Error('The circuit version has changed. Reload before generating runs.');
      }
      // POST is deliberately not retried: an interrupted response may still have created a run.
      const run = await this.call<Run>(batch, signal, '/runs', 'POST', { alias, playerId, nationalityCode, fake: true });
      batch.status.started++;
      const sim = new RobotSimulation(level);
      while (!sim.dead) {
        let crashAt: Obstacle | undefined;
        if (target <= sim.level.end) {
          // Use the next obstacle on the target level, or the last one before its gate or the distance cap.
          const obstacles = sim.level.obstacles.filter(obstacle => obstacle.distance <= MAX_FAKE_DISTANCE);
          crashAt = obstacles.find(obstacle => obstacle.distance >= target) ?? obstacles.at(-1);
          if (!crashAt) {
            throw new Error('No obstacle is available for the simulated collision.');
          }
        }
        await this.play(batch, sim, crashAt, signal);
        if (sim.dead) {
          break;
        }
        if (crashAt) {
          throw new Error('The simulated robot passed its final obstacle.');
        }
        const number = sim.level.number;
        await this.save(batch, signal, `/runs/${run.id}/checkpoints/${number}`, sim.progress());
        sim.loadLevel(await this.call<Level>(batch, signal, `/levels/${number + 1}`));
      }
      await this.save(batch, signal, `/runs/${run.id}/finish`, sim.progress());
      batch.status.completed++;
      try {
        await this.call(batch, signal, `/runs?playerId=${playerId}`);
      } catch {
        // The final save already succeeded; a failed history read does not undo a completed run.
      }
    } catch (error) {
      if (signal.aborted) {
        batch.status.cancelled++;
      } else {
        batch.status.failed++;
        batch.status.lastError = errorMessage(error);
      }
    } finally {
      actor.abort();
      await refresh;
      batch.status.active--;
    }
  }
}
