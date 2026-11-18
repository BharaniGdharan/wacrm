import { describe, expect, it, vi } from 'vitest';

import {
  HTTP_FETCH_MAX_RESPONSE_BYTES,
  HTTP_FETCH_MAX_VAR_LENGTH,
  applyResponseMappings,
  buildHttpRequest,
  executeHttpFetch,
  getByPath,
  renderHttpTemplate,
} from './http-fetch';
import type { HttpFetchNodeConfig } from './types';

const ctx = {
  vars: { order_id: 'A 1/2', qty: 3, note: 'say "hi"' },
  contact: {
    name: 'Ana',
    phone: '+15551234567',
    email: null,
    company: 'Acme & Co',
  },
};

function cfg(
  overrides: Partial<HttpFetchNodeConfig> = {}
): HttpFetchNodeConfig {
  return {
    method: 'GET',
    url: 'https://api.example.com/orders',
    success_next: 'ok',
    failure_next: 'fail',
    ...overrides,
  };
}

const allow = async () => true;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('renderHttpTemplate', () => {
  it('substitutes vars and contact fields, empty for unknown/missing', () => {
    expect(
      renderHttpTemplate(
        '{{vars.order_id}}|{{ contact.name }}|{{contact.email}}|{{vars.nope}}|{{contact.secret}}',
        ctx
      )
    ).toBe('A 1/2|Ana|||');
  });

  it('escapes only the substituted values, never the literal template', () => {
    expect(
      renderHttpTemplate('a b/{{vars.order_id}}', ctx, encodeURIComponent)
    ).toBe('a b/A%201%2F2');
  });

  it('stringifies non-string vars', () => {
    expect(renderHttpTemplate('{{vars.qty}}', ctx)).toBe('3');
    expect(renderHttpTemplate('{{vars.o}}', { vars: { o: { a: 1 } } })).toBe(
      '{"a":1}'
    );
  });
});

describe('buildHttpRequest', () => {
  it('URL-encodes placeholders in the URL and appends params via URLSearchParams', () => {
    const req = buildHttpRequest(
      cfg({
        url: 'https://api.example.com/orders/{{vars.order_id}}',
        params: [
          { key: 'phone', value: '{{contact.phone}}' },
          { key: '', value: 'ignored' },
        ],
      }),
      ctx
    );
    expect(req.url).toBe(
      'https://api.example.com/orders/A%201%2F2?phone=%2B15551234567'
    );
    expect(req.method).toBe('GET');
    expect(req.body).toBeUndefined();
  });

  it('JSON-escapes values inside a JSON body and sets content-type', () => {
    const req = buildHttpRequest(
      cfg({
        method: 'POST',
        body: '{"note":"{{vars.note}}","company":"{{contact.company}}"}',
      }),
      ctx
    );
    expect(JSON.parse(req.body!)).toEqual({
      note: 'say "hi"',
      company: 'Acme & Co',
    });
    expect(req.headers['content-type']).toBe('application/json');
  });

  it('form-encodes values in a form body', () => {
    const req = buildHttpRequest(
      cfg({
        method: 'POST',
        body_type: 'form',
        body: 'company={{contact.company}}',
      }),
      ctx
    );
    expect(req.body).toBe('company=Acme%20%26%20Co');
    expect(req.headers['content-type']).toBe(
      'application/x-www-form-urlencoded'
    );
  });

  it('keeps an explicit content-type header and lowercases header names', () => {
    const req = buildHttpRequest(
      cfg({
        method: 'POST',
        body_type: 'text',
        body: 'hi',
        headers: [{ key: 'Content-Type', value: 'application/xml' }],
      }),
      ctx
    );
    expect(req.headers['content-type']).toBe('application/xml');
  });

  it('strips CR/LF from header values (no header injection)', () => {
    const req = buildHttpRequest(
      cfg({ headers: [{ key: 'X-Name', value: '{{vars.evil}}' }] }),
      { vars: { evil: 'a\r\nX-Injected: 1' } }
    );
    expect(req.headers['x-name']).toBe('a  X-Injected: 1');
    expect(req.headers['x-injected']).toBeUndefined();
  });

  it('decrypts secret headers via resolveSecret, then renders placeholders', () => {
    const resolve = vi.fn((v: string) =>
      v === 'SEALED' ? 'Bearer {{vars.order_id}}' : v
    );
    const req = buildHttpRequest(
      cfg({
        headers: [{ key: 'Authorization', value: 'SEALED', secret: true }],
      }),
      ctx,
      resolve
    );
    expect(resolve).toHaveBeenCalledWith('SEALED');
    expect(req.headers.authorization).toBe('Bearer A 1/2');
  });

  it('rejects bad URLs, schemes, header names and unreadable secrets', () => {
    expect(() => buildHttpRequest(cfg({ url: 'not a url' }), ctx)).toThrow(
      'invalid_url'
    );
    expect(() => buildHttpRequest(cfg({ url: 'ftp://x.com/a' }), ctx)).toThrow(
      'unsupported_scheme'
    );
    expect(() =>
      buildHttpRequest(cfg({ headers: [{ key: 'Bad Name', value: 'x' }] }), ctx)
    ).toThrow('invalid_header_name');
    expect(() =>
      buildHttpRequest(
        cfg({ headers: [{ key: 'A', value: 'x', secret: true }] }),
        ctx,
        () => {
          throw new Error('bad tag');
        }
      )
    ).toThrow('secret_unreadable');
  });
});

describe('getByPath', () => {
  const doc = {
    data: {
      order: { status: 'shipped' },
      items: [{ name: 'Tea' }, { name: 'Cup' }],
    },
    zero: 0,
  };

  it('walks nested objects and array indices (dot and bracket forms)', () => {
    expect(getByPath(doc, 'data.order.status')).toBe('shipped');
    expect(getByPath(doc, 'data.items.1.name')).toBe('Cup');
    expect(getByPath(doc, 'data.items[0].name')).toBe('Tea');
    expect(getByPath(doc, 'zero')).toBe(0);
  });

  it('returns undefined for missing paths and the whole doc for an empty path', () => {
    expect(getByPath(doc, 'data.nope.x')).toBeUndefined();
    expect(getByPath(doc, 'data.items.name')).toBeUndefined();
    expect(getByPath(doc, 'data.order.status.length')).toBeUndefined();
    expect(getByPath(doc, '')).toBe(doc);
  });
});

describe('applyResponseMappings', () => {
  it('stores scalars as strings, objects as JSON, and removes vars for missing paths', () => {
    const next = applyResponseMappings(
      { keep: '1', stale: 'old' },
      { s: 'x', n: 2, b: false, o: { a: 1 }, nil: null },
      [
        { var_key: 's', path: 's' },
        { var_key: 'n', path: 'n' },
        { var_key: 'b', path: 'b' },
        { var_key: 'o', path: 'o' },
        { var_key: 'stale', path: 'missing' },
        { var_key: 'nil', path: 'nil' },
        { var_key: '', path: 's' },
      ]
    );
    expect(next).toEqual({
      keep: '1',
      s: 'x',
      n: '2',
      b: 'false',
      o: '{"a":1}',
    });
  });

  it('truncates large object values', () => {
    const big = { list: Array.from({ length: 1000 }, (_, i) => `item-${i}`) };
    const next = applyResponseMappings({}, big, [
      { var_key: 'all', path: 'list' },
    ]);
    expect((next.all as string).length).toBe(HTTP_FETCH_MAX_VAR_LENGTH);
  });
});

describe('executeHttpFetch', () => {
  it('succeeds on 2xx, maps JSON fields and the status var', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { status: 'shipped' } })
    );
    const out = await executeHttpFetch(
      cfg({
        response_mappings: [{ var_key: 'order_status', path: 'data.status' }],
        status_var: 'code',
      }),
      { vars: { a: '1' } },
      { fetchImpl: fetchImpl as unknown as typeof fetch, isDeliverable: allow }
    );
    expect(out.ok).toBe(true);
    expect(out.vars).toEqual({ a: '1', code: '200', order_status: 'shipped' });
    const init = (
      fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    )[1];
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('parses JSON without a json content-type when the body looks like JSON', async () => {
    const fetchImpl = async () => new Response('{"x":"y"}', { status: 200 });
    const out = await executeHttpFetch(
      cfg({ response_mappings: [{ var_key: 'x', path: 'x' }] }),
      { vars: {} },
      { fetchImpl: fetchImpl as unknown as typeof fetch, isDeliverable: allow }
    );
    expect(out.vars).toEqual({ x: 'y' });
  });

  it('fails on non-2xx but still records the status var', async () => {
    const out = await executeHttpFetch(
      cfg({
        status_var: 'code',
        response_mappings: [{ var_key: 'x', path: 'x' }],
      }),
      { vars: { x: 'kept' } },
      {
        fetchImpl: (async () =>
          jsonResponse({ x: 'no' }, 404)) as unknown as typeof fetch,
        isDeliverable: allow,
      }
    );
    expect(out).toMatchObject({
      ok: false,
      reason: 'http_status',
      status: 404,
    });
    expect(out.vars).toEqual({ x: 'kept', code: '404' });
  });

  it('treats a 3xx as failure (redirects are not followed)', async () => {
    const out = await executeHttpFetch(
      cfg(),
      { vars: {} },
      {
        fetchImpl: (async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'http://10.0.0.1' },
          })) as unknown as typeof fetch,
        isDeliverable: allow,
      }
    );
    expect(out).toMatchObject({
      ok: false,
      reason: 'redirect_not_followed',
      status: 302,
    });
  });

  it('blocks undeliverable destinations without calling fetch', async () => {
    const fetchImpl = vi.fn();
    const out = await executeHttpFetch(
      cfg({ url: 'http://127.0.0.1/admin' }),
      { vars: {} },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        isDeliverable: async () => false,
      }
    );
    expect(out).toMatchObject({ ok: false, reason: 'blocked_destination' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps timeouts and network errors', async () => {
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    const out1 = await executeHttpFetch(
      cfg(),
      { vars: {} },
      {
        fetchImpl: (async () => {
          throw timeout;
        }) as unknown as typeof fetch,
        isDeliverable: allow,
      }
    );
    expect(out1).toMatchObject({ ok: false, reason: 'timeout' });

    const out2 = await executeHttpFetch(
      cfg(),
      { vars: {} },
      {
        fetchImpl: (async () => {
          throw new TypeError('fetch failed');
        }) as unknown as typeof fetch,
        isDeliverable: allow,
      }
    );
    expect(out2).toMatchObject({
      ok: false,
      reason: 'network_error',
      detail: 'TypeError',
    });
  });

  it('returns invalid_config instead of throwing on a bad URL', async () => {
    const out = await executeHttpFetch(
      cfg({ url: '{{vars.missing}}' }),
      { vars: {} },
      { isDeliverable: allow }
    );
    expect(out).toMatchObject({
      ok: false,
      reason: 'invalid_config',
      detail: 'invalid_url',
    });
  });

  it('caps the response body: oversized responses succeed but map nothing', async () => {
    const huge = JSON.stringify({
      x: 'a'.repeat(HTTP_FETCH_MAX_RESPONSE_BYTES),
    });
    const out = await executeHttpFetch(
      cfg({ response_mappings: [{ var_key: 'x', path: 'x' }] }),
      { vars: { x: 'old' } },
      {
        fetchImpl: (async () =>
          new Response(huge, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof fetch,
        isDeliverable: allow,
      }
    );
    expect(out).toMatchObject({ ok: true, truncated: true });
    expect(out.vars).toEqual({});
  });
});
