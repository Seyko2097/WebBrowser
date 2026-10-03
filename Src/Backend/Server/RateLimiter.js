// Limitation du débit par client (seau à jetons) pour l'API publique.
export class RateLimiter {
  constructor({ perMinute = 120, burst = null, maxClients = 100_000 } = {}) {
    this.rate = perMinute / 60_000; // jetons par milliseconde
    this.burst = burst ?? Math.max(10, Math.ceil(perMinute / 4));
    this.maxClients = maxClients;
    this.buckets = new Map();
  }

  /** Consomme un jeton ; renvoie { ok, retryAfterMs }. */
  take(key, now = Date.now()) {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxClients) this.buckets.delete(this.buckets.keys().next().value);
      b = { tokens: this.burst, at: now };
    } else {
      this.buckets.delete(key); // remonte en fin de Map (LRU)
    }
    b.tokens = Math.min(this.burst, b.tokens + (now - b.at) * this.rate);
    b.at = now;
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, retryAfterMs: 0 };
    }
    return { ok: false, retryAfterMs: Math.ceil((1 - b.tokens) / this.rate) };
  }
}
