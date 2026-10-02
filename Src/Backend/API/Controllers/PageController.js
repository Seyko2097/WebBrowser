import { WebValidator } from '../../Crawler/Web-Crawler/WebValidator.js';
import { isOnionUrl, normalizeUrl, withScheme } from '../../Utils/Validator.js';
import { badRequest, ApiError } from './HttpErrors.js';

export class PageController {
  constructor({ browser, allowPrivateHosts = false }) {
    this.browser = browser;
    this.validator = new WebValidator({ allowPrivateHosts });
  }

  open = async (ctx) => {
    const raw = ctx.query.get('url');
    const url = raw && normalizeUrl(withScheme(raw));
    if (!url) throw badRequest('paramètre « url » invalide');
    if (!isOnionUrl(url)) {
      const verdict = await this.validator.check(url);
      if (!verdict.ok) throw badRequest(verdict.reason);
    }
    try {
      const page = await this.browser.open(url, { context: this.browser.newContext() });
      ctx.json(page);
    } catch (err) {
      throw new ApiError(502, err.message);
    }
  };
}
