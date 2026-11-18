/**
 * Runtime for the Flows "API request" node (`node_type: "http_fetch"`).
 *
 * Split into pure helpers (template rendering, request building, JSON
 * path extraction, var mapping) and one effectful `executeHttpFetch`
 * whose network / SSRF / secret dependencies are injectable, so the
 * whole node is unit-testable without a server or a Supabase mock.
 *
 * Safety model (mirrors the Automations `send_webhook` step and
 * lib/webhooks/deliver.ts):
 *   - The destination is account-controlled and the SERVER makes the
 *     request, so every URL goes through `isDeliverableUrl` (refuses
 *     loopback / private / link-local / reserved targets) unless the
 *     operator allow-lists a host in FLOW_HTTP_ALLOWED_PRIVATE_HOSTS.
 *   - Redirects are NOT followed (`redirect: 'manual'`) — a public URL
 *     could 3xx-bounce to an internal address and defeat the guard.
 *   - Bounded time (HTTP_FETCH_TIMEOUT_MS) and bounded response size
 *     (HTTP_FETCH_MAX_RESPONSE_BYTES).
 *   - Response bodies and header values are never logged.
 */

import {
  HEADER_NAME_RE,
  HTTP_TEMPLATE_CONTACT_FIELDS,
  httpPlaceholderRegex,
  type HttpTemplateContactField,
} from './http-placeholders';
import type {
  HttpFetchBodyType,
  HttpFetchNodeConfig,
  HttpFetchResponseMapping,
} from './types';

export const HTTP_FETCH_TIMEOUT_MS = 8_000;
export const HTTP_FETCH_MAX_RESPONSE_BYTES = 256 * 1024;
/** Objects/arrays copied into a var are JSON-stringified and capped here. */
export const HTTP_FETCH_MAX_VAR_LENGTH = 2_000;

export const PRIVATE_HOST_ALLOWLIST_ENV = 'FLOW_HTTP_ALLOWED_PRIVATE_HOSTS';

export interface HttpTemplateContext {
  vars: Record<string, unknown>;
  contact?: Partial<Record<HttpTemplateContactField, string | null>> | null;
}

// ============================================================
// Template rendering
// ============================================================

function resolvePlaceholder(
  ns: string,
  key: string,
  ctx: HttpTemplateContext
): string {
  if (ns === 'vars') {
    const v = ctx.vars[key];
    if (v === undefined || v === null) return '';
    return typeof v === 'string'
      ? v
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v);
  }
  if ((HTTP_TEMPLATE_CONTACT_FIELDS as readonly string[]).includes(key)) {
    const v = ctx.contact?.[key as HttpTemplateContactField];
    return typeof v === 'string' ? v : '';
  }
  return '';
}

/**
 * Replace `{{vars.x}}` / `{{contact.y}}` in `template`. Each resolved
 * value passes through `escape` so it can't break out of the slot it
 * lands in (URL component, JSON string, form field). The template's
 * literal text is never escaped — the author owns it.
 */
export function renderHttpTemplate(
  template: string | undefined,
  ctx: HttpTemplateContext,
  escape: (value: string) => string = (v) => v
): string {
  if (!template) return '';
  return template.replace(
    httpPlaceholderRegex(),
    (_, ns: string, key: string) => escape(resolvePlaceholder(ns, key, ctx))
  );
}

/** Escape a value for embedding INSIDE an existing JSON string literal. */
export function escapeJsonStringContent(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/** Strip characters that would allow header injection / splitting. */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\0]/g, ' ').trim();
}

// ============================================================
// Request building
// ============================================================

export class HttpFetchConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpFetchConfigError';
  }
}

export interface BuiltHttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

const CONTENT_TYPE_FOR: Record<HttpFetchBodyType, string> = {
  json: 'application/json',
  form: 'application/x-www-form-urlencoded',
  text: 'text/plain; charset=utf-8',
};

function escapeForBody(bodyType: HttpFetchBodyType): (v: string) => string {
  if (bodyType === 'json') return escapeJsonStringContent;
  if (bodyType === 'form') return encodeURIComponent;
  return (v) => v;
}

/**
 * Turn a node config + run context into a concrete request. Throws
 * `HttpFetchConfigError` for anything that can't be sent (bad URL,
 * non-http(s) scheme, illegal header name, undecryptable secret).
 *
 * `resolveSecret` maps a stored secret header value to its plaintext
 * (decrypt at call time); placeholders inside the decrypted value are
 * still rendered so `Bearer {{vars.token}}` works either way.
 */
export function buildHttpRequest(
  cfg: HttpFetchNodeConfig,
  ctx: HttpTemplateContext,
  resolveSecret: (stored: string) => string = (v) => v
): BuiltHttpRequest {
  const method = cfg.method === 'POST' ? 'POST' : 'GET';

  const rawUrl = renderHttpTemplate(cfg.url, ctx, encodeURIComponent).trim();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpFetchConfigError('invalid_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpFetchConfigError('unsupported_scheme');
  }

  for (const p of cfg.params ?? []) {
    const key = renderHttpTemplate(p.key, ctx).trim();
    if (!key) continue;
    url.searchParams.append(key, renderHttpTemplate(p.value, ctx));
  }

  const headers: Record<string, string> = {};
  for (const h of cfg.headers ?? []) {
    const name = (h.key ?? '').trim();
    if (!name) continue;
    if (!HEADER_NAME_RE.test(name)) {
      throw new HttpFetchConfigError('invalid_header_name');
    }
    let stored = h.value ?? '';
    if (h.secret) {
      try {
        stored = resolveSecret(stored);
      } catch {
        throw new HttpFetchConfigError('secret_unreadable');
      }
    }
    headers[name.toLowerCase()] = sanitizeHeaderValue(
      renderHttpTemplate(stored, ctx)
    );
  }
  if (!headers['accept']) headers['accept'] = 'application/json, */*;q=0.8';
  if (!headers['user-agent']) headers['user-agent'] = 'wacrm-flows/1.0';

  const built: BuiltHttpRequest = { url: url.toString(), method, headers };

  if (method === 'POST') {
    const bodyType: HttpFetchBodyType = cfg.body_type ?? 'json';
    built.body = renderHttpTemplate(
      cfg.body ?? '',
      ctx,
      escapeForBody(bodyType)
    );
    if (!headers['content-type'])
      headers['content-type'] = CONTENT_TYPE_FOR[bodyType];
  }

  return built;
}

// ============================================================
// Response handling
// ============================================================

/**
 * Read a value out of parsed JSON by dot path. Supports array indices
 * as segments (`items.0.name`) and bracket form (`items[0].name`). An
 * empty path returns the whole document. Missing → undefined.
 */
export function getByPath(doc: unknown, path: string): unknown {
  const normalized = path
    .trim()
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/^\./, '');
  if (!normalized) return doc;
  let cur: unknown = doc;
  for (const seg of normalized.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return undefined;
      cur = cur[Number(seg)];
    } else if (typeof cur === 'object') {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Coerce an extracted JSON value into the string stored in run.vars. */
export function toVarValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  const json = JSON.stringify(value);
  return json.length > HTTP_FETCH_MAX_VAR_LENGTH
    ? json.slice(0, HTTP_FETCH_MAX_VAR_LENGTH)
    : json;
}

/**
 * Return a new vars object with each mapping applied. A path that is
 * missing (or null) REMOVES the var, so a stale value from an earlier
 * call can't masquerade as this call's result and `condition`
 * present/absent checks stay truthful.
 */
export function applyResponseMappings(
  vars: Record<string, unknown>,
  doc: unknown,
  mappings: HttpFetchResponseMapping[] | undefined
): Record<string, unknown> {
  const next = { ...vars };
  for (const m of mappings ?? []) {
    const key = (m.var_key ?? '').trim();
    if (!key) continue;
    const value =
      doc === undefined ? undefined : toVarValue(getByPath(doc, m.path ?? ''));
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

async function readCappedText(
  res: Response,
  cap: number
): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    return text.length > cap
      ? { text: text.slice(0, cap), truncated: true }
      : { text, truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > cap) {
      chunks.push(value.subarray(0, cap - total));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

function parseJsonLoosely(text: string, contentType: string | null): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const looksJson =
    (contentType ?? '').toLowerCase().includes('json') ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('[');
  if (!looksJson) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

// ============================================================
// Execution
// ============================================================

export type HttpFetchFailureReason =
  | 'invalid_config'
  | 'call_limit'
  | 'blocked_destination'
  | 'timeout'
  | 'network_error'
  | 'redirect_not_followed'
  | 'http_status';

export type HttpFetchOutcome =
  | {
      ok: true;
      status: number;
      durationMs: number;
      /** True when the body exceeded the cap; mappings saw no document. */
      truncated: boolean;
      vars: Record<string, unknown>;
    }
  | {
      ok: false;
      reason: HttpFetchFailureReason;
      status?: number;
      /** Short machine-ish detail (never a response body / header value). */
      detail?: string;
      durationMs: number;
      vars: Record<string, unknown>;
    };

export interface HttpFetchDeps {
  fetchImpl?: typeof fetch;
  isDeliverable?: (url: string) => Promise<boolean>;
  resolveSecret?: (stored: string) => string;
  timeoutMs?: number;
  now?: () => number;
}

function withStatusVar(
  vars: Record<string, unknown>,
  statusVar: string | undefined,
  status: number | undefined
): Record<string, unknown> {
  const key = (statusVar ?? '').trim();
  if (!key) return vars;
  const next = { ...vars };
  if (status === undefined) delete next[key];
  else next[key] = String(status);
  return next;
}

/**
 * Perform the request described by `cfg`. Never throws — every problem
 * becomes `{ ok: false, reason }` so the engine can route to the
 * node's failure branch. `vars` in the result is the run's vars with
 * `status_var` (both outcomes) and response mappings (success only)
 * applied.
 */
export async function executeHttpFetch(
  cfg: HttpFetchNodeConfig,
  ctx: HttpTemplateContext,
  deps: HttpFetchDeps = {}
): Promise<HttpFetchOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  const elapsed = () => Math.max(0, now() - started);
  const fetchImpl = deps.fetchImpl ?? fetch;

  let req: BuiltHttpRequest;
  try {
    req = buildHttpRequest(cfg, ctx, deps.resolveSecret);
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid_config',
      detail:
        err instanceof HttpFetchConfigError ? err.message : 'build_failed',
      durationMs: elapsed(),
      vars: withStatusVar(ctx.vars, cfg.status_var, undefined),
    };
  }

  const isDeliverable = deps.isDeliverable ?? defaultIsDeliverable;
  if (!(await isDeliverable(req.url))) {
    return {
      ok: false,
      reason: 'blocked_destination',
      durationMs: elapsed(),
      vars: withStatusVar(ctx.vars, cfg.status_var, undefined),
    };
  }

  let res: Response;
  try {
    res = await fetchImpl(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.timeoutMs ?? HTTP_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    return {
      ok: false,
      reason: timedOut ? 'timeout' : 'network_error',
      detail: timedOut ? undefined : name || 'fetch_failed',
      durationMs: elapsed(),
      vars: withStatusVar(ctx.vars, cfg.status_var, undefined),
    };
  }

  const status = res.status;
  const varsWithStatus = withStatusVar(ctx.vars, cfg.status_var, status);

  if (status >= 300 && status < 400) {
    await res.body?.cancel().catch(() => {});
    return {
      ok: false,
      reason: 'redirect_not_followed',
      status,
      durationMs: elapsed(),
      vars: varsWithStatus,
    };
  }
  if (status < 200 || status >= 300) {
    await res.body?.cancel().catch(() => {});
    return {
      ok: false,
      reason: 'http_status',
      status,
      durationMs: elapsed(),
      vars: varsWithStatus,
    };
  }

  let doc: unknown = undefined;
  let truncated = false;
  try {
    const read = await readCappedText(res, HTTP_FETCH_MAX_RESPONSE_BYTES);
    truncated = read.truncated;
    if (!truncated)
      doc = parseJsonLoosely(read.text, res.headers.get('content-type'));
  } catch {
    // Body read failed after a 2xx — still a success; mappings see nothing.
  }

  return {
    ok: true,
    status,
    durationMs: elapsed(),
    truncated,
    vars: applyResponseMappings(varsWithStatus, doc, cfg.response_mappings),
  };
}

function allowedPrivateHosts(): string[] {
  return (process.env[PRIVATE_HOST_ALLOWLIST_ENV] ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
}

async function defaultIsDeliverable(url: string): Promise<boolean> {
  const { isDeliverableUrl } = await import('@/lib/webhooks/ssrf');
  return isDeliverableUrl(url, { allowPrivateHosts: allowedPrivateHosts() });
}
