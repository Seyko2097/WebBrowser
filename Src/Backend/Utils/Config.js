import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import defaults from '../../../Config/config.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const ENV_OVERRIDES = {
  WEBBROWSER_DB: ['database.file', String],
  WEBBROWSER_TOR_HOST: ['tor.host', String],
  WEBBROWSER_TOR_PORT: ['tor.port', Number],
  WEBBROWSER_PROXY: ['network.proxy', String],
  WEBBROWSER_API_HOST: ['api.host', String],
  WEBBROWSER_API_PORT: ['api.port', Number],
  LOG_LEVEL: ['log.level', String],
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function deepMerge(target, ...sources) {
  for (const src of sources) {
    if (!isObject(src)) continue;
    for (const [key, value] of Object.entries(src)) {
      if (isObject(value) && isObject(target[key])) deepMerge(target[key], value);
      else target[key] = structuredClone(value);
    }
  }
  return target;
}

function getPath(obj, keyPath) {
  return keyPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, keyPath, value) {
  const keys = keyPath.split('.');
  const last = keys.pop();
  let cur = obj;
  for (const k of keys) {
    if (!isObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[last] = value;
}

function homePaths(home) {
  return {
    paths: {
      data: home, cache: path.join(home, 'Cache'), downloads: path.join(home, 'Downloads'), index: path.join(home, 'Index'),
      logs: path.join(home, 'Logs'), settings: path.join(home, 'settings.json'),
    },
    database: { file: path.join(home, 'Index', 'index.db') },
    log: { file: path.join(home, 'Logs', 'webbrowser.log') },
  };
}

/** Chemins XDG : ~/.local/share, ~/.cache, ~/.config, ~/.local/state. */
function systemPaths(env) {
  const home = env.HOME ?? '/tmp';
  const data = path.join(env.XDG_DATA_HOME || path.join(home, '.local/share'), 'webbrowser');
  const cache = path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'webbrowser');
  const conf = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'webbrowser');
  const state = path.join(env.XDG_STATE_HOME || path.join(home, '.local/state'), 'webbrowser');
  return {
    paths: {
      data, cache, downloads: path.join(data, 'Downloads'), index: path.join(data, 'Index'),
      logs: state, settings: path.join(conf, 'settings.json'),
    },
    database: { file: path.join(data, 'Index', 'index.db') },
    log: { file: path.join(state, 'webbrowser.log') },
    onion: { blocklistFile: env.WEBBROWSER_SYSTEM_BLOCKLIST ?? '/etc/webbrowser/onion-blocklist.txt' },
  };
}

export class Config {
  constructor({ root = ROOT, overrides = {}, settingsFile, env = process.env, loadSettings = true, mode } = {}) {
    this.root = root;
    this.data = structuredClone(defaults);
    // Mode « system » (application installée) : données dans les dossiers XDG de l'utilisateur
    this.mode = mode ?? (env.WEBBROWSER_MODE === 'system' ? 'system' : 'portable');
    if (this.mode === 'system') {
      deepMerge(this.data, systemPaths(env));
      deepMerge(this.data, Config.readSettings(env.WEBBROWSER_SYSTEM_CONFIG ?? '/etc/webbrowser/config.json'));
    }
    if (env.WEBBROWSER_HOME) deepMerge(this.data, homePaths(env.WEBBROWSER_HOME));
    this.settingsFile = this.resolve(settingsFile ?? this.data.paths.settings);
    this.user = loadSettings ? Config.readSettings(this.settingsFile) : {};
    deepMerge(this.data, this.user);
    for (const [name, [keyPath, cast]] of Object.entries(ENV_OVERRIDES)) {
      if (env[name] !== undefined && env[name] !== '') setPath(this.data, keyPath, cast(env[name]));
    }
    deepMerge(this.data, overrides);
  }

  static readSettings(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  }

  get(keyPath, fallback) {
    const v = getPath(this.data, keyPath);
    return v === undefined ? fallback : v;
  }

  /** Modifie une valeur ; elle sera persistée par save(). */
  set(keyPath, value) {
    setPath(this.data, keyPath, value);
    setPath(this.user, keyPath, value);
  }

  save() {
    fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
    const tmp = `${this.settingsFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.user, null, 2));
    fs.renameSync(tmp, this.settingsFile);
  }

  /** Chemin absolu à partir d'un chemin relatif à la racine du projet. */
  resolve(p) {
    if (p == null || p === ':memory:') return p;
    return path.isAbsolute(p) ? p : path.join(this.root, p);
  }

  path(keyPath) {
    return this.resolve(this.get(keyPath));
  }
}
