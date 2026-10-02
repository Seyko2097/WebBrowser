// File FIFO à amortissement constant (pas de Array.shift en O(n)).
export class Queue {
  constructor(items = []) {
    this.items = [];
    this.head = 0;
    for (const item of items) this.push(item);
  }

  push(item) {
    this.items.push(item);
    return this;
  }

  shift() {
    if (this.head >= this.items.length) return undefined;
    const item = this.items[this.head];
    this.items[this.head++] = undefined;
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }

  peek() {
    return this.items[this.head];
  }

  get size() {
    return this.items.length - this.head;
  }

  isEmpty() {
    return this.size === 0;
  }

  clear() {
    this.items = [];
    this.head = 0;
  }

  *[Symbol.iterator]() {
    for (let i = this.head; i < this.items.length; i++) yield this.items[i];
  }
}
