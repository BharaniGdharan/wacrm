import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';

import en from '../../../../messages/en.json';
import ko from '../../../../messages/ko.json';
import { SECRET_MASK } from '@/lib/flows/http-secrets';
import type { BuilderNode } from '../shared';
import { summarizeNode } from '../shared';
import { HttpFetchForm, type HttpFetchCfg } from './http-fetch-form';

// Smoke test: the API request form renders in every state without
// throwing, and every string it reads exists (onError throws on a
// missing key instead of silently printing the key path).

const nodes: BuilderNode[] = [
  {
    node_key: 'ask',
    node_type: 'collect_input',
    config: { var_key: 'order_id' },
  },
  { node_key: 'api', node_type: 'http_fetch', config: {} },
  { node_key: 'ok', node_type: 'end', config: {} },
];

function render(
  cfg: HttpFetchCfg,
  messages: Record<string, unknown> = en,
  locale = 'en'
) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      timeZone="UTC"
      onError={(e) => {
        throw e;
      }}
    >
      <HttpFetchForm
        cfg={cfg}
        allNodes={nodes}
        currentKey="api"
        onUpdateConfig={() => {}}
      />
    </NextIntlClientProvider>
  );
}

describe('HttpFetchForm', () => {
  it('renders an empty GET with placeholder hints from other nodes', () => {
    const html = render({ method: 'GET' });
    expect(html).toContain('Import from cURL');
    expect(html).toContain('{{vars.order_id}}');
    expect(html).toContain('{{contact.phone}}');
    expect(html).not.toContain('Body');
  });

  it('renders a POST with headers, a stored secret and mappings', () => {
    const html = render({
      method: 'POST',
      url: 'https://api.example.com/x',
      headers: [
        { key: 'Authorization', value: SECRET_MASK, secret: true },
        { key: 'Accept', value: 'application/json' },
      ],
      body: '{"a":1}',
      response_mappings: [{ var_key: 'status', path: 'data.status' }],
    });
    expect(html).toContain('Stored securely');
    expect(html).not.toContain(SECRET_MASK);
    expect(html).toContain('Body');
    expect(html).toContain('data.status');
  });

  it('renders in another locale', () => {
    expect(render({ method: 'GET' }, ko, 'ko')).toContain('cURL에서 가져오기');
  });
});

describe('summarizeNode — http_fetch', () => {
  it('shows method, target and how many vars it saves', () => {
    const node: BuilderNode = {
      node_key: 'api',
      node_type: 'http_fetch',
      config: {
        method: 'POST',
        url: 'https://api.example.com/leads',
        response_mappings: [
          { var_key: 'id', path: 'id' },
          { var_key: '', path: 'x' },
        ],
      },
    };
    expect(summarizeNode(node)).toBe('POST api.example.com/leads → 1 vars');
    expect(summarizeNode({ ...node, config: { url: '' } })).toBeNull();
  });
});
