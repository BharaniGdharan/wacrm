/**
 * Secret header handling for Flows "API request" (`http_fetch`) nodes.
 *
 * flow_nodes rows are readable by every account member (viewers too —
 * see `flow_nodes_select` in migration 017), so a header flagged
 * `secret: true` must never sit in the row as plaintext:
 *
 *   PUT /api/flows/[id]  → `sealSecretHeaders`   plaintext → `enc:v1:<gcm>`
 *   GET /api/flows/[id]  → `maskSecretHeaders`   ciphertext → SECRET_MASK
 *   engine (call time)   → `openSecretHeader`    ciphertext → plaintext
 *
 * The editor round-trips SECRET_MASK for an untouched secret; sealing
 * then keeps the previously stored ciphertext for that header. The
 * crypto functions are injected so this module stays pure / testable;
 * callers pass `encrypt` / `decrypt` from lib/whatsapp/encryption.
 */

/** What the editor sees (and sends back) for a stored, unchanged secret. */
export const SECRET_MASK = '••••••••';

const ENC_PREFIX = 'enc:v1:';

export function isSealedSecret(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

interface NodeLike {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
}

interface HeaderLike {
  key?: unknown;
  value?: unknown;
  secret?: unknown;
}

function headersOf(config: Record<string, unknown>): HeaderLike[] {
  return Array.isArray(config.headers) ? (config.headers as HeaderLike[]) : [];
}

function headerName(h: HeaderLike): string {
  return typeof h.key === 'string' ? h.key.trim().toLowerCase() : '';
}

/**
 * Encrypt every secret header value on incoming nodes before they are
 * written. `existing` is the flow's current node list from the DB.
 *
 * Per secret header:
 *   - value === SECRET_MASK → keep the stored ciphertext of the header
 *     with the same name on the same node_key (or "" if there is none —
 *     e.g. a duplicated node; the user must re-enter it).
 *   - value equals that stored ciphertext → keep it.
 *   - "" → "".
 *   - anything else → treated as new plaintext and encrypted.
 * Per NON-secret header: a mask or ciphertext can't be used as a real
 * value (the user un-ticked "secret" without retyping), so it becomes "".
 */
export function sealSecretHeaders<T extends NodeLike>(
  nodes: T[],
  existing: NodeLike[],
  encrypt: (plain: string) => string
): T[] {
  const stored = new Map<string, Map<string, string>>();
  for (const n of existing) {
    if (n.node_type !== 'http_fetch') continue;
    const byName = new Map<string, string>();
    for (const h of headersOf(n.config)) {
      if (h.secret && isSealedSecret(h.value))
        byName.set(headerName(h), h.value);
    }
    stored.set(n.node_key, byName);
  }

  return nodes.map((n) => {
    if (n.node_type !== 'http_fetch') return n;
    const headers = headersOf(n.config);
    if (headers.length === 0) return n;
    const previous = stored.get(n.node_key) ?? new Map<string, string>();
    const sealed = headers.map((h) => {
      const value = typeof h.value === 'string' ? h.value : '';
      if (!h.secret) {
        return value === SECRET_MASK || isSealedSecret(value)
          ? { ...h, value: '' }
          : h;
      }
      const prior = previous.get(headerName(h));
      if (value === SECRET_MASK)
        return { ...h, secret: true, value: prior ?? '' };
      if (prior !== undefined && value === prior) return { ...h, secret: true };
      if (value === '') return { ...h, secret: true, value: '' };
      return { ...h, secret: true, value: ENC_PREFIX + encrypt(value) };
    });
    return { ...n, config: { ...n.config, headers: sealed } };
  });
}

/** Replace stored secret values with SECRET_MASK for the editor. */
export function maskSecretHeaders<T extends NodeLike>(nodes: T[]): T[] {
  return nodes.map((n) => {
    if (n.node_type !== 'http_fetch') return n;
    const headers = headersOf(n.config);
    if (!headers.some((h) => h.secret)) return n;
    return {
      ...n,
      config: {
        ...n.config,
        headers: headers.map((h) =>
          h.secret && typeof h.value === 'string' && h.value !== ''
            ? { ...h, value: SECRET_MASK }
            : h
        ),
      },
    };
  });
}

/**
 * Plaintext for a stored secret header value (engine, call time).
 * A value that was never sealed (e.g. created by a template) passes
 * through unchanged; a sealed value that fails to decrypt throws.
 */
export function openSecretHeader(
  stored: string,
  decrypt: (cipher: string) => string
): string {
  if (stored === SECRET_MASK) throw new Error('secret_not_sealed');
  return isSealedSecret(stored)
    ? decrypt(stored.slice(ENC_PREFIX.length))
    : stored;
}
