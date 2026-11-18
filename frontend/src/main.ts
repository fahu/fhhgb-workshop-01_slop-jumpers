import './style.css';
import { mountRunSession } from './game/session';
import { mountLeaderboard } from './leaderboard/panel';
import { mountPlayerActivity } from './runs/activity';
import { mountRunHistory } from './runs/history';
import { mountInstructorSettings } from './workshop/settings';

function getPlayerId(): string {
  const key = 'slop-jumpers.player';
  let playerId: string = crypto.randomUUID();
  try {
    const savedPlayerId = localStorage.getItem(key);
    if (savedPlayerId) {
      return savedPlayerId;
    }
    playerId = localStorage.getItem('slop-jumper.player') || playerId;
    localStorage.setItem(key, playerId);
  } catch {
    // Players can still play for this visit when local storage is unavailable.
  }
  return playerId;
}

const playerId = getPlayerId();

const refreshHistory = mountRunHistory(playerId);
const refreshActivity = mountPlayerActivity();
const leaderboard = mountLeaderboard();
const session = mountRunSession(playerId, {
  started() {
    void refreshActivity();
    void refreshHistory();
  },
  saved: refreshHistory,
  finished: leaderboard.refreshInBackground,
  autoplay: () => workshop.autoplay(),
});

const workshop = mountInstructorSettings({
  dataChanged() {
    void refreshActivity();
    void refreshHistory();
    void leaderboard.refresh();
  },
  dialogChanged: session.setInstructorOpen,
  trafficChanged: leaderboard.setTrafficRunning,
  retryFailures: () => Promise.all([session.retry(), leaderboard.retry()]),
});
leaderboard.onRecoverTraffic(workshop.stopTrafficAndDrain);
