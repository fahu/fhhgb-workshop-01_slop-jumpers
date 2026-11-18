export interface Progress { distance: number; tokens: number; elapsedMs: number; collisionId?: string | null }
export interface Nationality { code: string; name: string }
export interface PlayerProfile { playerId: string; alias: string; nationalityCode: string }
export interface Run extends Progress {
  id: string; playerId: string; alias: string; finished: boolean; createdAt: number;
  nationalityCode: string; courseVersion: string; levelLength: number; fakeSource: 'client' | 'seed' | null;
}
export interface Receipt { distance: number; checkpoint: number; duplicate: boolean; finished: boolean }
export interface Leaderboard {
  generatedAt: number;
  entries: { alias: string; distance: number; tokens: number; nationality: Nationality; finished: boolean; collisionId: string | null }[];
}
export interface PlayerActivity { players: number; windowMinutes: number; asOf: number }
export interface Obstacle { distance: number; width: number; height: number; slopId: string }
export interface Level {
  number: number; courseVersion: string; start: number; end: number;
  obstacles: Obstacle[];
  // The level API keeps the existing field name for collectible positions.
  stars: { id: number; distance: number; height: number }[];
}
export interface Scenario {
  loseConfirmation: boolean;
  requestFailurePercent: number;
  randomRequestDelay: boolean;
}
export interface Workshop {
  scenario: Scenario;
  database: { maxConnections: number; defaultConnections: number; active: number; idle: number; total: number; waiting: number; connectionTimeoutMs: number };
  leaderboard: { active: number; queued: number; builds: number; rejected: number; workers: number; deadlineMs: number };
}

export interface RunCounts {
  totalRuns: number; rankedPlayers: number; recentPlayers: number; startedOnlyRuns: number;
  removableFakeRuns: number; protectedRuns: number;
}
