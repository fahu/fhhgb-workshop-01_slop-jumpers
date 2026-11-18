import { request, errorMessage } from '../api';
import { text } from '../dom';
import type { PlayerActivity } from '../types';

export function mountPlayerActivity() {
  let activityLoading = false;

  async function loadActivity(): Promise<void> {
    if (activityLoading) {
      return;
    }
    activityLoading = true;
    try {
      const activity = await request<PlayerActivity>('/activity');
      text('player-count', activity.players.toLocaleString());
      text('player-activity-label', `${activity.players === 1 ? 'player' : 'players'} in the last 30 minutes`);
      text('player-activity-status', '');
    } catch (error) {
      text('player-count', '—');
      text('player-activity-status', errorMessage(error));
    } finally {
      activityLoading = false;
    }
  }

  void loadActivity();
  setInterval(() => {
    if (!document.hidden) {
      void loadActivity();
    }
  }, 10000);
  return loadActivity;
}
