/**
 * Parse a pasted cURL command into an "API request" (`http_fetch`)
 * node config. Runs in the browser (builder form) — no Node imports.
 *
 * Handles what API docs and browser devtools ("Copy as cURL (bash)")
 * actually emit:
 *   - quoting: '…', "…" (with \ escapes), $'…' (ANSI-C), bare \ escapes,
 *     and backslash-newline continuations;
 *   - -X/--request, -H/--header, -d/--data/--data-raw/--data-binary/
 *     --data-ascii, --data-urlencode, --json, -G/--get, -u/--user,
 *     -A/--user-agent, -e/--referer, -b/--cookie, --url;
 *   - no-op flags (-s -S -L -k -i -v -f -g --compressed …) are skipped.
 *
 * Only GET/POST are supported by the node; other methods come back as a
 * warning and fall back to POST (with a body) or GET. Browser noise
 * headers (sec-*, accept-encoding, content-length, …) are dropped, and
 * auth-looking headers are pre-marked `secret` so they get encrypted.
 */

import type {
  HttpFetchBodyType,
  HttpFetchHeader,
  HttpFetchKeyValue,
  HttpFetchMethod,
} from './types';

export type CurlImportWarning =
  | { code: 'unsupported_method'; detail: string }
  | { code: 'multipart_unsupported' }
  | { code: 'ignored_option'; detail: string }
  | { code: 'dropped_headers'; detail: string }
  | { code: 'multiple_urls' };

export interface CurlImportConfig {
  method: HttpFetchMethod;
  url: string;
  params: HttpFetchKeyValue[];
  headers: HttpFetchHeader[];
  body: string;
  body_type: HttpFetchBodyType;
}

export type CurlImportResult =
  | { ok: true; config: CurlImportConfig; warnings: CurlImportWarning[] }
  | { ok: false; error: 'empty' | 'unterminated_quote' | 'no_url' };

// ============================================================
// Tokenizer (POSIX-shell-ish, enough for curl one-liners)
// ============================================================

const ANSI_C_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '0': '\0',
};

export function tokenizeShell(input: string): string[] | null {
  const src = input.replace(/\\\r?\n/g, ' ');
  const tokens: string[] = [];
  let cur = '';
  let inToken = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(cur);
        cur = '';
        inToken = false;
      }
      i += 1;
      continue;
    }
    inToken = true;
    if (ch === '$' && src[i + 1] === "'") {
      i += 2;
      let closed = false;
      while (i < src.length) {
        const c = src[i];
        if (c === '\\' && i + 1 < src.length) {
          const esc = src[i + 1];
          cur += ANSI_C_ESCAPES[esc] ?? esc;
          i += 2;
          continue;
        }
        if (c === "'") {
          closed = true;
          i += 1;
          break;
        }
        cur += c;
        i += 1;
      }
      if (!closed) return null;
      continue;
    }
    if (ch === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) return null;
      cur += src.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      let closed = false;
      while (i < src.length) {
        const c = src[i];
        if (c === '\\' && i + 1 < src.length && '"\\$`'.includes(src[i + 1])) {
          cur += src[i + 1];
          i += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          i += 1;
          break;
        }
        cur += c;
        i += 1;
      }
      if (!closed) return null;
      continue;
    }
    if (ch === '\\' && i + 1 < src.length) {
      cur += src[i + 1];
      i += 2;
      continue;
    }
    cur += ch;
    i += 1;
  }
  if (inToken) tokens.push(cur);
  return tokens;
}

// ============================================================
// Option tables
// ============================================================

const NO_ARG_FLAGS = new Set([
  '-s',
  '--silent',
  '-S',
  '--show-error',
  '-L',
  '--location',
  '-k',
  '--insecure',
  '-i',
  '--include',
  '-v',
  '--verbose',
  '--compressed',
  '-f',
  '--fail',
  '-g',
  '--globoff',
  '-N',
  '--no-buffer',
  '--http1.0',
  '--http1.1',
  '--http2',
  '--http2-prior-knowledge',
  '-#',
  '--progress-bar',
  '-4',
  '--ipv4',
  '-6',
  '--ipv6',
  '-j',
  '--junk-session-cookies',
  '--location-trusted',
  '--fail-with-body',
]);

const IGNORED_ARG_FLAGS = new Set([
  '-o',
  '--output',
  '-m',
  '--max-time',
  '--connect-timeout',
  '-w',
  '--write-out',
  '--retry',
  '--retry-delay',
  '--retry-max-time',
  '-x',
  '--proxy',
  '--cacert',
  '--capath',
  '-E',
  '--cert',
  '--key',
  '-c',
  '--cookie-jar',
  '-r',
  '--range',
  '--resolve',
  '--limit-rate',
  '-K',
  '--config',
  '--max-redirs',
  '--interface',
]);

const DATA_FLAGS = new Set([
  '-d',
  '--data',
  '--data-raw',
  '--data-binary',
  '--data-ascii',
]);

const DROPPED_HEADERS = new Set([
  'content-length',
  'host',
  'connection',
  'accept-encoding',
  'priority',
  'upgrade-insecure-requests',
  'te',
  'keep-alive',
  'dnt',
]);

const SECRET_HEADER_RE =
  /^(authorization|proxy-authorization|cookie)$|token|secret|api[-_]?key|auth/i;

export function looksSecretHeader(name: string): boolean {
  return SECRET_HEADER_RE.test(name.trim());
}

function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function safeDecode(component: string): string {
  try {
    return decodeURIComponent(component.replace(/\+/g, ' '));
  } catch {
    return component;
  }
}

function parseQueryPairs(query: string): HttpFetchKeyValue[] {
  return query
    .split('&')
    .filter((p) => p.length > 0)
    .map((pair) => {
      const eq = pair.indexOf('=');
      return eq === -1
        ? { key: safeDecode(pair), value: '' }
        : {
            key: safeDecode(pair.slice(0, eq)),
            value: safeDecode(pair.slice(eq + 1)),
          };
    });
}

function urlencodeDataArg(arg: string): string {
  // curl --data-urlencode forms: "content", "=content", "name=content"
  const eq = arg.indexOf('=');
  if (eq === -1) return encodeURIComponent(arg);
  const name = arg.slice(0, eq);
  const value = encodeURIComponent(arg.slice(eq + 1));
  return name ? `${name}=${value}` : value;
}

function inferBodyType(
  body: string,
  contentType: string | undefined,
  forcedJson: boolean
): HttpFetchBodyType {
  const ct = (contentType ?? '').toLowerCase();
  if (forcedJson || ct.includes('json')) return 'json';
  if (ct.includes('x-www-form-urlencoded')) return 'form';
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(trimmed)) return 'form';
  return 'text';
}

// ============================================================
// Main entry
// ============================================================

export function parseCurl(input: string): CurlImportResult {
  if (!input.trim()) return { ok: false, error: 'empty' };
  const tokens = tokenizeShell(input.trim());
  if (!tokens) return { ok: false, error: 'unterminated_quote' };
  if (tokens[0] === 'curl') tokens.shift();

  const warnings: CurlImportWarning[] = [];
  let explicitMethod: string | null = null;
  let getMode = false;
  let forcedJson = false;
  const urls: string[] = [];
  const dataParts: string[] = [];
  const rawHeaders: Array<{ key: string; value: string }> = [];

  const takeArg = (idx: number): string | undefined => tokens[idx + 1];

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];

    // Attached short forms: -XPOST, -H'…' already split by shell, but
    // `-XPOST` stays one token.
    if (/^-X.+/.test(tok) && !tok.startsWith('--')) {
      explicitMethod = tok.slice(2);
      continue;
    }

    // --long=value form
    let flag = tok;
    let inlineValue: string | undefined;
    if (tok.startsWith('--') && tok.includes('=')) {
      flag = tok.slice(0, tok.indexOf('='));
      inlineValue = tok.slice(tok.indexOf('=') + 1);
    }
    const value = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue;
      const v = takeArg(i);
      i += 1;
      return v;
    };

    if (!flag.startsWith('-') || flag === '-') {
      urls.push(tok);
      continue;
    }
    if (NO_ARG_FLAGS.has(flag)) continue;
    if (IGNORED_ARG_FLAGS.has(flag)) {
      value();
      continue;
    }

    switch (flag) {
      case '-X':
      case '--request':
        explicitMethod = value() ?? null;
        break;
      case '-H':
      case '--header': {
        const h = value() ?? '';
        const colon = h.indexOf(':');
        if (colon > 0) {
          rawHeaders.push({
            key: h.slice(0, colon).trim(),
            value: h.slice(colon + 1).trim(),
          });
        }
        break;
      }
      case '--json':
        forcedJson = true;
        dataParts.push(value() ?? '');
        break;
      case '--data-urlencode':
        dataParts.push(urlencodeDataArg(value() ?? ''));
        break;
      case '-G':
      case '--get':
        getMode = true;
        break;
      case '-u':
      case '--user': {
        const creds = value() ?? '';
        rawHeaders.push({
          key: 'Authorization',
          value: `Basic ${base64Utf8(creds)}`,
        });
        break;
      }
      case '-A':
      case '--user-agent':
        rawHeaders.push({ key: 'User-Agent', value: value() ?? '' });
        break;
      case '-e':
      case '--referer':
        rawHeaders.push({ key: 'Referer', value: value() ?? '' });
        break;
      case '-b':
      case '--cookie':
        rawHeaders.push({ key: 'Cookie', value: value() ?? '' });
        break;
      case '--url':
        urls.push(value() ?? '');
        break;
      case '-F':
      case '--form':
      case '--form-string':
        value();
        if (!warnings.some((w) => w.code === 'multipart_unsupported')) {
          warnings.push({ code: 'multipart_unsupported' });
        }
        break;
      default:
        if (DATA_FLAGS.has(flag)) {
          dataParts.push(value() ?? '');
        } else {
          warnings.push({ code: 'ignored_option', detail: flag });
        }
    }
  }

  const rawUrl = urls.find((u) => u.trim().length > 0);
  if (!rawUrl) return { ok: false, error: 'no_url' };
  if (urls.filter((u) => u.trim()).length > 1)
    warnings.push({ code: 'multiple_urls' });

  // Split the query string off into editable params.
  const hashless = rawUrl.split('#')[0];
  const qIdx = hashless.indexOf('?');
  const baseUrl = qIdx === -1 ? hashless : hashless.slice(0, qIdx);
  const params = qIdx === -1 ? [] : parseQueryPairs(hashless.slice(qIdx + 1));

  const joinedData = dataParts.join(forcedJson ? '' : '&');
  let body = '';
  if (dataParts.length > 0) {
    if (getMode) params.push(...parseQueryPairs(joinedData));
    else body = joinedData;
  }

  // Method resolution.
  let method: HttpFetchMethod = body ? 'POST' : 'GET';
  if (explicitMethod) {
    const m = explicitMethod.toUpperCase();
    if (m === 'GET' || m === 'POST') method = m;
    else warnings.push({ code: 'unsupported_method', detail: m });
  }
  if (getMode) method = 'GET';

  // Headers: drop browser/transport noise, flag secrets, pull content-type.
  const dropped: string[] = [];
  let contentType: string | undefined;
  const headers: HttpFetchHeader[] = [];
  for (const h of rawHeaders) {
    const lower = h.key.toLowerCase();
    if (DROPPED_HEADERS.has(lower) || lower.startsWith('sec-')) {
      dropped.push(h.key);
      continue;
    }
    if (lower === 'content-type') {
      contentType = h.value;
      continue;
    }
    headers.push(
      looksSecretHeader(h.key)
        ? { key: h.key, value: h.value, secret: true }
        : { key: h.key, value: h.value }
    );
  }
  if (dropped.length > 0)
    warnings.push({ code: 'dropped_headers', detail: dropped.join(', ') });

  const bodyType =
    method === 'POST' ? inferBodyType(body, contentType, forcedJson) : 'json';
  // Keep a content-type the body type wouldn't set by itself.
  if (
    contentType &&
    method === 'POST' &&
    !(bodyType === 'json' && contentType.toLowerCase().includes('json')) &&
    !(
      bodyType === 'form' &&
      contentType.toLowerCase().includes('x-www-form-urlencoded')
    )
  ) {
    headers.push({ key: 'Content-Type', value: contentType });
  }

  return {
    ok: true,
    config: {
      method,
      url: baseUrl,
      params,
      headers,
      body: method === 'POST' ? body : '',
      body_type: bodyType,
    },
    warnings,
  };
}
