import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeTables } from './fake-db.test-helper';

// ============================================================
// API request (http_fetch) node, end to end through the real
// `dispatchInboundToFlows`: a keyword starts the flow, the node calls
// a stubbed fetch, response fields land in flow_runs.vars, and the
// next send_message interpolates them. Meta sends and the SSRF DNS
// check are stubbed; the Supabase layer is the in-memory fake DB.
// ============================================================

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  sendText: vi.fn<
    (args: { text: string }) => Promise<{ whatsapp_message_id: string }>
  >(async () => ({ whatsapp_message_id: 'wamid.text' })),
}));

vi.mock('./admin-client', async () => {
  const { createFakeDb } = await import('./fake-db.test-helper');
  return { supabaseAdmin: () => createFakeDb(h.tables as FakeTables) };
});

vi.mock('./meta-send', () => ({
  engineSendText: h.sendText,
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: 'wamid.media' })),
  engineSendInteractiveButtons: vi.fn(async () => ({
    whatsapp_message_id: 'wamid.buttons',
  })),
  engineSendInteractiveList: vi.fn(async () => ({
    whatsapp_message_id: 'wamid.list',
  })),
}));

vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async (url: string) => !url.includes('127.0.0.1')),
}));

import { dispatchInboundToFlows } from './engine';
import { encrypt } from '@/lib/whatsapp/encryption';

const FLOW = {
  id: 'flow-api',
  account_id: 'acct-1',
  user_id: 'u-1',
  status: 'active',
  trigger_type: 'keyword',
  trigger_config: { keywords: ['order'] },
  entry_node_id: 'start',
  fallback_policy: {},
  created_at: '2026-01-01T00:00:00Z',
};

function apiNode(key: string, config: Record<string, unknown>) {
  return {
    flow_id: 'flow-api',
    node_key: key,
    node_type: 'http_fetch',
    config: {
      method: 'GET',
      url: 'https://api.example.com/orders',
      params: [{ key: 'phone', value: '{{contact.phone}}' }],
      response_mappings: [{ var_key: 'order_status', path: 'data.status' }],
      status_var: 'code',
      success_next: 'ok',
      failure_next: 'sorry',
      ...config,
    },
  };
}

function baseNodes(api: Record<string, unknown> = apiNode('api', {})) {
  return [
    {
      flow_id: 'flow-api',
      node_key: 'start',
      node_type: 'start',
      config: { next_node_key: 'api' },
    },
    api,
    {
      flow_id: 'flow-api',
      node_key: 'ok',
      node_type: 'send_message',
      config: {
        text: 'Status: {{vars.order_status}} ({{vars.code}})',
        next_node_key: 'done',
      },
    },
    {
      flow_id: 'flow-api',
      node_key: 'sorry',
      node_type: 'send_message',
      config: {
        text: 'Sorry, lookup failed ({{vars.code}})',
        next_node_key: 'done',
      },
    },
    { flow_id: 'flow-api', node_key: 'done', node_type: 'end', config: {} },
  ];
}

function setup(nodes = baseNodes()) {
  h.tables = {
    flows: [FLOW],
    flow_nodes: structuredClone(nodes),
    flow_runs: [],
    flow_run_events: [],
    messages: [],
    contacts: [
      {
        id: 'ct-1',
        name: 'Ana',
        phone: '+15551234567',
        email: null,
        company: null,
      },
    ],
  };
}

const fetchMock =
  vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

function respondJson(body: unknown, status = 200) {
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
  );
}

function dispatchOrder() {
  return dispatchInboundToFlows({
    accountId: 'acct-1',
    userId: 'u-1',
    contactId: 'ct-1',
    conversationId: 'cv-1',
    message: { kind: 'text', text: 'order', meta_message_id: 'm-order' },
    isFirstInboundMessage: false,
  });
}

const sentTexts = () => h.sendText.mock.calls.map((c) => c[0].text);
const events = () => h.tables.flow_run_events as Array<Record<string, unknown>>;

beforeEach(() => {
  h.sendText.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('http_fetch node in a running flow', () => {
  it('calls the API with contact placeholders, saves response vars, and replies with them', async () => {
    setup();
    respondJson({ data: { status: 'shipped' } });

    await dispatchOrder();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/orders?phone=%2B15551234567');
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('manual');

    expect(sentTexts()).toEqual(['Status: shipped (200)']);
    const run = h.tables.flow_runs[0];
    expect(run.vars).toMatchObject({ order_status: 'shipped', code: '200' });
    expect(run.status).toBe('completed');

    // The loop logs a generic node_entered on entry; the outcome event is the one with a branch.
    const httpEvent = events().find(
      (e) => (e.payload as Record<string, unknown>)?.branch === 'success'
    );
    expect(httpEvent).toMatchObject({
      event_type: 'node_entered',
      node_key: 'api',
      payload: expect.objectContaining({
        http_status: 200,
        branch: 'success',
        advancing_to: 'ok',
      }),
    });
    // The response body never lands in the audit log.
    expect(JSON.stringify(events())).not.toContain('shipped');
  });

  it('routes a non-2xx to the failure branch and logs the status', async () => {
    setup();
    respondJson({ error: 'nope' }, 503);

    await dispatchOrder();

    expect(sentTexts()).toEqual(['Sorry, lookup failed (503)']);
    expect(h.tables.flow_runs[0].vars).not.toHaveProperty('order_status');
    expect(events()).toContainEqual(
      expect.objectContaining({
        event_type: 'error',
        node_key: 'api',
        payload: expect.objectContaining({
          reason: 'http_fetch_failed',
          failure: 'http_status',
          http_status: 503,
          branch: 'failure',
        }),
      })
    );
  });

  it('refuses private destinations without calling fetch', async () => {
    setup(baseNodes(apiNode('api', { url: 'http://127.0.0.1:8080/internal' })));

    await dispatchOrder();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sentTexts()).toEqual(['Sorry, lookup failed ()']);
    expect(events()).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ failure: 'blocked_destination' }),
      })
    );
  });

  it('decrypts sealed secret headers only at call time', async () => {
    setup(
      baseNodes(
        apiNode('api', {
          headers: [
            {
              key: 'Authorization',
              value: `enc:v1:${encrypt('Bearer s3cr3t')}`,
              secret: true,
            },
          ],
        })
      )
    );
    respondJson({ data: { status: 'ok' } });

    await dispatchOrder();

    const headers = fetchMock.mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(headers.authorization).toBe('Bearer s3cr3t');
    expect(JSON.stringify(events())).not.toContain('s3cr3t');
  });

  it('caps API calls per advance and takes the failure branch past the cap', async () => {
    const chain = [
      {
        flow_id: 'flow-api',
        node_key: 'start',
        node_type: 'start',
        config: { next_node_key: 'a1' },
      },
      apiNode('a1', { success_next: 'a2', response_mappings: [] }),
      apiNode('a2', { success_next: 'a3', response_mappings: [] }),
      apiNode('a3', { success_next: 'a4', response_mappings: [] }),
      apiNode('a4', { success_next: 'ok', response_mappings: [] }),
      ...baseNodes().slice(2),
    ];
    setup(chain);
    respondJson({});

    await dispatchOrder();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(events()).toContainEqual(
      expect.objectContaining({
        node_key: 'a4',
        payload: expect.objectContaining({ failure: 'call_limit' }),
      })
    );
    expect(sentTexts()).toEqual(['Sorry, lookup failed (200)']);
  });
});
