// Ordonnanceur poli : une file par hôte, tourniquet entre hôtes, délai minimal entre deux
// requêtes vers un même hôte (respecte Crawl-delay) et nombre de requêtes simultanées par hôte limité.
import { Queue } from './Queue.js';

const MAX_DELAY_MS = 60_000;

export class Scheduler {
  constructor({ delayMs = 500, perHostConcurrency = 1 } = {}) {
    this.delayMs = delayMs;
    this.perHostConcurrency = perHostConcurrency;
    this.hosts = new Map();
    this.order = [];
    this.cursor = 0;
    this.pending = 0;
    this.inFlight = 0;
  }

  hostState(host) {
    let state = this.hosts.get(host);
    if (!state) {
      state = { queue: new Queue(), nextAt: 0, active: 0, delayMs: this.delayMs };
      this.hosts.set(host, state);
      this.order.push(host);
    }
    return state;
  }

  add(task) {
    const host = new URL(task.url).host;
    this.hostState(host).queue.push(task);
    this.pending++;
  }

  /** Applique un Crawl-delay (en secondes) annoncé par robots.txt. */
  setCrawlDelay(host, seconds) {
    if (seconds == null) return;
    const state = this.hostState(host);
    state.delayMs = Math.min(MAX_DELAY_MS, Math.max(this.delayMs, seconds * 1000));
  }

  /**
   * Prochaine tâche à lancer :
   *  { task } si une tâche est prête, { waitMs } s'il faut patienter, null si tout est vide.
   */
  next(now = Date.now()) {
    if (this.pending === 0) return null;
    let minWait = Infinity;
    for (let k = 0; k < this.order.length; k++) {
      const idx = (this.cursor + k) % this.order.length;
      const host = this.order[idx];
      const state = this.hosts.get(host);
      if (state.queue.isEmpty()) continue;
      if (state.active >= this.perHostConcurrency) continue;
      if (state.nextAt > now) {
        minWait = Math.min(minWait, state.nextAt - now);
        continue;
      }
      const task = state.queue.shift();
      state.active++;
      state.nextAt = now + state.delayMs;
      this.pending--;
      this.inFlight++;
      this.cursor = (idx + 1) % this.order.length;
      return { task, host };
    }
    return { waitMs: minWait };
  }

  /** Signale la fin d'une tâche lancée par next(). */
  done(task, now = Date.now()) {
    const state = this.hosts.get(new URL(task.url).host);
    if (!state) return;
    state.active = Math.max(0, state.active - 1);
    state.nextAt = Math.max(state.nextAt, now + state.delayMs);
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  clear() {
    for (const state of this.hosts.values()) state.queue.clear();
    this.pending = 0;
  }

  get size() {
    return this.pending;
  }
}
