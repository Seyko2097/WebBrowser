// Pool de ressources coûteuses (pages Playwright, clients…) avec file d'attente et taille maximale.
export class BrowserPool {
  constructor({ size = 2, create, destroy = async () => {}, acquireTimeoutMs = 60000 } = {}) {
    if (typeof create !== 'function') throw new Error('BrowserPool : fonction create manquante');
    this.size = Math.max(1, size);
    this.create = create;
    this.destroyFn = destroy;
    this.acquireTimeoutMs = acquireTimeoutMs;
    this.idle = [];
    this.busy = new Set();
    this.waiters = [];
    this.creating = 0;
    this.closed = false;
  }

  get total() {
    return this.idle.length + this.busy.size + this.creating;
  }

  async acquire() {
    if (this.closed) throw new Error('pool fermé');
    const idle = this.idle.pop();
    if (idle) {
      this.busy.add(idle);
      return idle;
    }
    if (this.total < this.size) {
      this.creating++;
      try {
        const resource = await this.create();
        this.busy.add(resource);
        return resource;
      } finally {
        this.creating--;
      }
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error('délai dépassé en attendant une ressource du pool'));
      }, this.acquireTimeoutMs);
      this.waiters.push(waiter);
    });
  }

  release(resource) {
    if (!this.busy.has(resource)) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(resource);
      return;
    }
    this.busy.delete(resource);
    if (this.closed) this.destroyFn(resource).catch(() => {});
    else this.idle.push(resource);
  }

  /** Retire une ressource défectueuse du pool. */
  async discard(resource) {
    this.busy.delete(resource);
    await this.destroyFn(resource).catch(() => {});
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      this.acquire().then(waiter.resolve, waiter.reject);
    }
  }

  async use(fn) {
    const resource = await this.acquire();
    try {
      const result = await fn(resource);
      this.release(resource);
      return result;
    } catch (err) {
      await this.discard(resource);
      throw err;
    }
  }

  async close() {
    this.closed = true;
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error('pool fermé'));
    }
    this.waiters = [];
    const idle = this.idle.splice(0);
    await Promise.all(idle.map((r) => this.destroyFn(r).catch(() => {})));
  }
}
