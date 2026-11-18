import { describe, expect, it } from 'vitest';

import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import {
  SECRET_MASK,
  isSealedSecret,
  maskSecretHeaders,
  openSecretHeader,
  sealSecretHeaders,
} from './http-secrets';

const fakeEncrypt = (v: string) => `C(${v})`;

function httpNode(key: string, headers: unknown[]) {
  return {
    node_key: key,
    node_type: 'http_fetch',
    config: { url: 'https://x.io', headers },
  };
}

describe('sealSecretHeaders', () => {
  it('encrypts new secret values and leaves non-secret headers alone', () => {
    const [n] = sealSecretHeaders(
      [
        httpNode('api', [
          { key: 'Authorization', value: 'Bearer t', secret: true },
          { key: 'Accept', value: 'application/json' },
        ]),
      ],
      [],
      fakeEncrypt
    );
    expect(n.config.headers).toEqual([
      { key: 'Authorization', value: 'enc:v1:C(Bearer t)', secret: true },
      { key: 'Accept', value: 'application/json' },
    ]);
  });

  it('keeps the stored ciphertext when the editor sends the mask back', () => {
    const existing = [
      httpNode('api', [
        { key: 'authorization', value: 'enc:v1:OLD', secret: true },
      ]),
    ];
    const [n] = sealSecretHeaders(
      [
        httpNode('api', [
          { key: 'Authorization', value: SECRET_MASK, secret: true },
        ]),
      ],
      existing,
      fakeEncrypt
    );
    expect(n.config.headers).toEqual([
      { key: 'Authorization', value: 'enc:v1:OLD', secret: true },
    ]);
  });

  it('keeps an unchanged ciphertext but re-encrypts anything else that looks sealed', () => {
    const existing = [
      httpNode('api', [{ key: 'A', value: 'enc:v1:OLD', secret: true }]),
    ];
    const [same] = sealSecretHeaders(
      [httpNode('api', [{ key: 'A', value: 'enc:v1:OLD', secret: true }])],
      existing,
      fakeEncrypt
    );
    expect((same.config.headers as Array<{ value: string }>)[0].value).toBe(
      'enc:v1:OLD'
    );

    // A pasted ciphertext that isn't this header's stored value is treated
    // as plaintext — it can't be used to smuggle another secret in.
    const [other] = sealSecretHeaders(
      [httpNode('api', [{ key: 'A', value: 'enc:v1:FOREIGN', secret: true }])],
      existing,
      fakeEncrypt
    );
    expect((other.config.headers as Array<{ value: string }>)[0].value).toBe(
      'enc:v1:C(enc:v1:FOREIGN)'
    );
  });

  it('drops a mask with no stored secret (duplicated node) and when un-secreted', () => {
    const existing = [
      httpNode('api', [{ key: 'A', value: 'enc:v1:OLD', secret: true }]),
    ];
    const [dup, unsecret] = sealSecretHeaders(
      [
        httpNode('api_copy', [{ key: 'A', value: SECRET_MASK, secret: true }]),
        httpNode('api', [{ key: 'A', value: SECRET_MASK, secret: false }]),
      ],
      existing,
      fakeEncrypt
    );
    expect((dup.config.headers as Array<{ value: string }>)[0].value).toBe('');
    expect((unsecret.config.headers as Array<{ value: string }>)[0].value).toBe(
      ''
    );
  });

  it('passes non-http nodes through by identity', () => {
    const other = {
      node_key: 'm',
      node_type: 'send_message',
      config: { text: 'hi' },
    };
    expect(sealSecretHeaders([other], [], fakeEncrypt)[0]).toBe(other);
  });
});

describe('maskSecretHeaders', () => {
  it('masks non-empty secret values only', () => {
    const [n] = maskSecretHeaders([
      httpNode('api', [
        { key: 'A', value: 'enc:v1:X', secret: true },
        { key: 'B', value: '', secret: true },
        { key: 'C', value: 'plain' },
      ]),
    ]);
    expect(n.config.headers).toEqual([
      { key: 'A', value: SECRET_MASK, secret: true },
      { key: 'B', value: '', secret: true },
      { key: 'C', value: 'plain' },
    ]);
  });
});

describe('openSecretHeader with the real AES-256-GCM helpers', () => {
  it('round-trips seal → open', () => {
    const [n] = sealSecretHeaders(
      [httpNode('api', [{ key: 'X-Api-Key', value: 's3cr3t', secret: true }])],
      [],
      encrypt
    );
    const stored = (n.config.headers as Array<{ value: string }>)[0].value;
    expect(isSealedSecret(stored)).toBe(true);
    expect(stored).not.toContain('s3cr3t');
    expect(openSecretHeader(stored, decrypt)).toBe('s3cr3t');
  });

  it('passes unsealed values through and refuses the mask', () => {
    expect(openSecretHeader('plain', decrypt)).toBe('plain');
    expect(() => openSecretHeader(SECRET_MASK, decrypt)).toThrow();
  });
});
