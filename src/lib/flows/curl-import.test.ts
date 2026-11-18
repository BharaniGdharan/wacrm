import { describe, expect, it } from 'vitest';

import { looksSecretHeader, parseCurl, tokenizeShell } from './curl-import';

function ok(input: string) {
  const r = parseCurl(input);
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r;
}

describe('tokenizeShell', () => {
  it('handles single, double, ANSI-C quotes, escapes and line continuations', () => {
    expect(
      tokenizeShell(`curl 'a b' "c \\"d\\"" $'e\\nf' g\\ h \\\n  -s`)
    ).toEqual(['curl', 'a b', 'c "d"', 'e\nf', 'g h', '-s']);
  });

  it('returns null on an unterminated quote', () => {
    expect(tokenizeShell("curl 'https://x")).toBeNull();
    expect(tokenizeShell('curl "https://x')).toBeNull();
  });
});

describe('parseCurl', () => {
  it('parses a simple GET and splits the query into params', () => {
    const r = ok(
      "curl 'https://api.example.com/orders?phone=%2B1555&status=open'"
    );
    expect(r.config).toMatchObject({
      method: 'GET',
      url: 'https://api.example.com/orders',
      params: [
        { key: 'phone', value: '+1555' },
        { key: 'status', value: 'open' },
      ],
      headers: [],
      body: '',
    });
    expect(r.warnings).toEqual([]);
  });

  it('infers POST from --data and detects a JSON body', () => {
    const r = ok(
      `curl https://api.example.com/leads -H 'Content-Type: application/json' -H 'X-Api-Key: abc' -d '{"name":"Ana"}'`
    );
    expect(r.config.method).toBe('POST');
    expect(r.config.body).toBe('{"name":"Ana"}');
    expect(r.config.body_type).toBe('json');
    // content-type implied by body_type → not duplicated as a header
    expect(r.config.headers).toEqual([
      { key: 'X-Api-Key', value: 'abc', secret: true },
    ]);
  });

  it('supports --json, -XPOST, --request=PATCH warnings and --url', () => {
    expect(ok(`curl --json '{"a":1}' https://x.io/a`).config).toMatchObject({
      method: 'POST',
      body_type: 'json',
    });
    expect(ok(`curl -XPOST https://x.io/a`).config.method).toBe('POST');
    const patched = ok(`curl --request=PATCH --url https://x.io/a -d 'a=1'`);
    expect(patched.config.method).toBe('POST');
    expect(patched.warnings).toContainEqual({
      code: 'unsupported_method',
      detail: 'PATCH',
    });
  });

  it('moves -G data into params', () => {
    const r = ok(`curl -G https://x.io/search -d q=tea -d 'page=2'`);
    expect(r.config.method).toBe('GET');
    expect(r.config.params).toEqual([
      { key: 'q', value: 'tea' },
      { key: 'page', value: '2' },
    ]);
    expect(r.config.body).toBe('');
  });

  it('turns -u into a secret Basic auth header', () => {
    const r = ok(`curl -u user:pa:ss https://x.io/a`);
    expect(r.config.headers).toEqual([
      {
        key: 'Authorization',
        value: `Basic ${btoa('user:pa:ss')}`,
        secret: true,
      },
    ]);
  });

  it('detects form bodies and urlencodes --data-urlencode values', () => {
    const r = ok(
      `curl https://x.io/a --data-urlencode 'msg=hello world' -d 'x=1'`
    );
    expect(r.config.body).toBe('msg=hello%20world&x=1');
    expect(r.config.body_type).toBe('form');
  });

  it("cleans up a browser 'Copy as cURL' command", () => {
    const chrome = `curl 'https://api.example.com/v1/me' \\
  -H 'accept: application/json' \\
  -H 'accept-language: en-US,en;q=0.9' \\
  -H 'authorization: Bearer eyJabc' \\
  -H 'sec-ch-ua: "Chromium";v="130"' \\
  -H 'sec-fetch-mode: cors' \\
  -H 'priority: u=1, i' \\
  -b 'session=xyz' \\
  --compressed`;
    const r = ok(chrome);
    expect(r.config.url).toBe('https://api.example.com/v1/me');
    expect(r.config.headers).toEqual([
      { key: 'accept', value: 'application/json' },
      { key: 'accept-language', value: 'en-US,en;q=0.9' },
      { key: 'authorization', value: 'Bearer eyJabc', secret: true },
      { key: 'Cookie', value: 'session=xyz', secret: true },
    ]);
    expect(r.warnings).toContainEqual({
      code: 'dropped_headers',
      detail: 'sec-ch-ua, sec-fetch-mode, priority',
    });
  });

  it('keeps {{placeholders}} intact', () => {
    const r = ok(
      `curl 'https://x.io/orders/{{vars.order_id}}?phone={{contact.phone}}'`
    );
    expect(r.config.url).toBe('https://x.io/orders/{{vars.order_id}}');
    expect(r.config.params).toEqual([
      { key: 'phone', value: '{{contact.phone}}' },
    ]);
  });

  it('warns about multipart, unknown options and multiple URLs', () => {
    const r = ok(
      `curl -F file=@a.png --frobnicate https://x.io/a https://x.io/b`
    );
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        { code: 'multipart_unsupported' },
        { code: 'ignored_option', detail: '--frobnicate' },
        { code: 'multiple_urls' },
      ])
    );
    expect(r.config.url).toBe('https://x.io/a');
  });

  it('reports empty input, missing URL and broken quoting', () => {
    expect(parseCurl('   ')).toEqual({ ok: false, error: 'empty' });
    expect(parseCurl('curl -s')).toEqual({ ok: false, error: 'no_url' });
    expect(parseCurl("curl 'https://x")).toEqual({
      ok: false,
      error: 'unterminated_quote',
    });
  });

  it('skips no-op flags and their arguments', () => {
    const r = ok(`curl -s -L -k -o out.json -m 10 https://x.io/a`);
    expect(r.config.url).toBe('https://x.io/a');
    expect(r.warnings).toEqual([]);
  });
});

describe('looksSecretHeader', () => {
  it('flags auth-ish header names only', () => {
    for (const h of [
      'Authorization',
      'X-API-Key',
      'api_key',
      'X-Auth-Token',
      'Cookie',
      'X-Client-Secret',
    ]) {
      expect(looksSecretHeader(h)).toBe(true);
    }
    for (const h of ['Accept', 'Content-Type', 'X-Request-Id']) {
      expect(looksSecretHeader(h)).toBe(false);
    }
  });
});
