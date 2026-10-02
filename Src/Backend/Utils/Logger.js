import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export class Logger {
  constructor({ level = 'info', file = null, console: toConsole = false, scope = '' } = {}) {
    this.level = LEVELS[level] ?? LEVELS.info;
    this.scope = scope;
    this.toConsole = toConsole;
    this.stream = null;
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.stream = fs.createWriteStream(file, { flags: 'a' });
      this.stream.on('error', () => { this.stream = null; });
    }
  }

  static silent() {
    return new Logger({ level: 'silent' });
  }

  child(scope) {
    const child = Object.create(this);
    child.scope = this.scope ? `${this.scope}:${scope}` : scope;
    return child;
  }

  log(level, message, meta) {
    if ((LEVELS[level] ?? 0) < this.level) return;
    const line = [new Date().toISOString(), level.toUpperCase().padEnd(5), this.scope && `[${this.scope}]`, message,
      meta === undefined ? '' : JSON.stringify(meta)].filter(Boolean).join(' ');
    if (this.stream) this.stream.write(line + '\n');
    if (this.toConsole) (level === 'error' || level === 'warn' ? console.error : console.log)(line);
  }

  debug(msg, meta) { this.log('debug', msg, meta); }
  info(msg, meta) { this.log('info', msg, meta); }
  warn(msg, meta) { this.log('warn', msg, meta); }
  error(msg, meta) { this.log('error', msg, meta); }

  close() {
    this.stream?.end();
    this.stream = null;
  }
}
