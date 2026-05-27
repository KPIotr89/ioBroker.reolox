'use strict';

/**
 * Logging helpers shared by every module.
 *
 *  - sanitize(): strips CRLF and control chars so untrusted strings (e.g. event
 *    types received from a webhook) cannot inject log lines.
 *  - maskUrl(): redacts password / user info from URLs before they are logged.
 *  - mask(): redacts a password-like string ("secret123" → "se***23").
 */

// eslint-disable-next-line no-control-regex
const CTRL = /[\r\n\x00-\x1f]/g;

function sanitize(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(CTRL, '_');
}

function mask(secret) {
    if (!secret) return '';
    const s = String(secret);
    if (s.length <= 4) return '****';
    return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

/**
 * Replace `user:password@host` and `?password=...` / `&password=...`
 * occurrences inside a URL with `****`.
 * @param {string} url
 * @returns {string}
 */
function maskUrl(url) {
    if (!url) return '';
    let out = String(url);
    // Match `scheme://user:password@host` — capture scheme + user, mask password.
    out = out.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:/?#@\s]+):([^@\s]+)@/g,
        (_m, scheme, user) => `${scheme}${user}:****@`);
    out = out.replace(/([?&])(password|user|token)=([^&#]*)/gi, (_m, p, k) => `${p}${k}=****`);
    return out;
}

module.exports = { sanitize, mask, maskUrl };
