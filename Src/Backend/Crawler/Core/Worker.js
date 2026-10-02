// Traite une URL : robots.txt → téléchargement → analyse → document à indexer + liens à suivre.
import { parsePage } from '../Parsers/HtmlParser.js';
import { followableUrls, discoveryLinks } from '../Parsers/LinkParser.js';
import { parseRobotsDirectives, mergeRobots } from '../Parsers/MetadataParser.js';
import { Document } from '../Indexer/Document.js';
import { isHtmlType } from '../../Network/Headers.js';
import { normalizeUrl } from '../../Utils/Validator.js';

export class Worker {
  constructor({ client, robots = null, parse = parsePage, network = 'web', maxBodyChars = 200_000, logger = null } = {}) {
    this.client = client;
    this.robots = robots;
    this.parse = parse;
    this.network = network;
    this.maxBodyChars = maxBodyChars;
    this.logger = logger;
  }

  /**
   * @returns {Promise<{status: 'indexed'|'skipped'|'error', url: string, finalUrl?: string,
   *   document?: Document, links: string[], reason?: string, httpStatus?: number}>}
   */
  async process(task) {
    const { url } = task;
    if (this.robots && !(await this.robots.isAllowed(url))) {
      return { status: 'skipped', url, links: [], reason: 'interdit par robots.txt' };
    }
    let res;
    try {
      res = await this.client.get(url, { noCache: true });
    } catch (err) {
      return { status: 'error', url, links: [], reason: err.message };
    }
    const finalUrl = normalizeUrl(res.url) ?? url;
    if (!res.ok) {
      return { status: 'error', url, finalUrl, links: [], reason: `HTTP ${res.status}`, httpStatus: res.status };
    }
    if (!isHtmlType(res.mime) && res.mime !== 'text/plain') {
      return { status: 'skipped', url, finalUrl, links: [], reason: `type ignoré : ${res.mime}` };
    }
    if (finalUrl !== url && this.robots && !(await this.robots.isAllowed(finalUrl))) {
      return { status: 'skipped', url, finalUrl, links: [], reason: 'redirection interdite par robots.txt' };
    }

    if (res.mime === 'text/plain') {
      const text = res.text();
      const document = new Document({
        url: finalUrl, title: finalUrl.split('/').pop() || finalUrl, body: text.slice(0, this.maxBodyChars),
        network: this.network, status: res.status,
      });
      return { status: 'indexed', url, finalUrl, document, links: [], httpStatus: res.status };
    }

    const page = this.parse(res.text(), finalUrl);
    const robots = mergeRobots(page.meta.robots, parseRobotsDirectives(res.headers['x-robots-tag']));
    let links = robots.nofollow ? [] : followableUrls(page.links);
    if (!robots.nofollow) links = [...new Set([...links, ...discoveryLinks(page.doc, finalUrl), ...(page.extraLinks ?? [])])];
    if (page.meta.refresh && !robots.nofollow) links.push(page.meta.refresh);
    if (robots.noindex) {
      return { status: 'skipped', url, finalUrl, links, reason: 'noindex', httpStatus: res.status };
    }
    const document = Document.fromPage(page, {
      network: this.network, status: res.status, maxBodyChars: this.maxBodyChars, links,
    });
    // Une URL canonique différente sur le même site remplace l'URL téléchargée
    if (page.meta.canonical && new URL(page.meta.canonical).host === new URL(finalUrl).host) {
      document.url = page.meta.canonical;
    }
    return { status: 'indexed', url, finalUrl, document, links, httpStatus: res.status };
  }
}
