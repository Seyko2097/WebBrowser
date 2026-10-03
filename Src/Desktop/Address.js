// Interprétation de la barre d'adresse (sans dépendance à Electron, testable seule).
import { looksLikeUrl, normalizeUrl, withScheme, isOnionUrl } from '../Backend/Utils/Validator.js';
import { SEARCH_ENGINES } from '../Backend/Utils/SettingsSchema.js';

export const INTERNAL_SCHEME = 'webbrowser';
export const HOME_URL = 'webbrowser://home/';

export function isInternalUrl(url) {
  return /^webbrowser:/i.test(String(url ?? ''));
}

export function internalUrl(page, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return `webbrowser://${page}/${qs ? `?${qs}` : ''}`;
}

/** URL de recherche pour le moteur choisi (version .onion quand elle existe, dans un onglet Tor). */
export function searchUrl(query, { engine = 'webbrowser', tor = false } = {}) {
  const e = SEARCH_ENGINES[engine] ?? SEARCH_ENGINES.webbrowser;
  const template = (tor && e.onion) || e.url;
  return template.replace('%s', encodeURIComponent(query));
}

/**
 * Transforme la saisie de la barre d'adresse en URL à charger.
 * Renvoie { url, onion } ou null si la saisie est vide.
 */
export function resolveInput(input, options = {}) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (isInternalUrl(text)) {
    try {
      const u = new URL(text);
      return { url: u.toString(), onion: false };
    } catch {
      return { url: HOME_URL, onion: false };
    }
  }
  if (/^about:blank$/i.test(text)) return { url: 'about:blank', onion: false };
  // Schémas dangereux ou locaux : traités comme une recherche
  if (/^(javascript|data|file|vbscript|chrome|devtools|view-source):/i.test(text)) {
    return { url: searchUrl(text, options), onion: false };
  }
  if (looksLikeUrl(text) || /^https?:\/\//i.test(text) || /^[a-z2-7]{56}\.onion(\/|$)/i.test(text)) {
    const url = normalizeUrl(withScheme(text));
    if (url) return { url, onion: isOnionUrl(url) };
  }
  return { url: searchUrl(text, options), onion: false };
}

/** Texte à afficher dans la barre d'adresse pour une URL (les pages internes gardent leur adresse). */
export function displayUrl(url) {
  if (!url || url === 'about:blank') return '';
  if (url === HOME_URL) return '';
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}
