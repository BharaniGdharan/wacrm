'use client';

/**
 * Builder form for the "API request" (`http_fetch`) flow node.
 *
 * Kept in its own file (rather than inside node-config-form.tsx) so
 * the shared form only gains a single `case` — smaller diff to carry
 * when syncing this fork with upstream.
 *
 * Secret headers: a stored secret arrives from GET /api/flows/[id] as
 * SECRET_MASK. The form never shows or edits that sentinel directly —
 * it renders "stored securely" with a Replace button, and sending the
 * mask back on save tells the server to keep the stored ciphertext.
 */

import { useMemo, useState } from 'react';
import { Lock, Plus, TerminalSquare, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { parseCurl, type CurlImportWarning } from '@/lib/flows/curl-import';
import { HTTP_TEMPLATE_CONTACT_FIELDS } from '@/lib/flows/http-placeholders';
import { SECRET_MASK } from '@/lib/flows/http-secrets';
import type { BuilderNode } from '../shared';
import { NextNodeRow } from './fields';

interface KeyValue {
  key: string;
  value: string;
}
interface Header extends KeyValue {
  secret?: boolean;
}
interface Mapping {
  var_key: string;
  path: string;
}

export interface HttpFetchCfg {
  method?: 'GET' | 'POST';
  url?: string;
  params?: KeyValue[];
  headers?: Header[];
  body?: string;
  body_type?: 'json' | 'form' | 'text';
  response_mappings?: Mapping[];
  status_var?: string;
  success_next?: string;
  failure_next?: string;
}

const sanitizeVarKey = (v: string) => v.replace(/[^a-zA-Z0-9_]/g, '');

/** Var keys other nodes in this flow can produce — shown as hints. */
function knownVarKeys(allNodes: BuilderNode[]): string[] {
  const keys = new Set<string>();
  for (const n of allNodes) {
    const c = n.config as Record<string, unknown>;
    if (
      n.node_type === 'collect_input' &&
      typeof c.var_key === 'string' &&
      c.var_key
    ) {
      keys.add(c.var_key);
    }
    if (n.node_type === 'http_fetch') {
      if (typeof c.status_var === 'string' && c.status_var)
        keys.add(c.status_var);
      if (Array.isArray(c.response_mappings)) {
        for (const m of c.response_mappings as Mapping[]) {
          if (m?.var_key) keys.add(m.var_key);
        }
      }
    }
  }
  return [...keys].sort();
}

const label = 'mb-1 block text-xs text-muted-foreground';
const sectionTitle = 'text-xs font-medium text-foreground';

export function HttpFetchForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: {
  cfg: HttpFetchCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const t = useTranslations('Flows.builder.form.http');
  const [curlOpen, setCurlOpen] = useState(false);

  const method = cfg.method === 'POST' ? 'POST' : 'GET';
  const params = cfg.params ?? [];
  const headers = cfg.headers ?? [];
  const mappings = cfg.response_mappings ?? [];
  const varHints = useMemo(() => knownVarKeys(allNodes), [allNodes]);

  const setParam = (i: number, patch: Partial<KeyValue>) =>
    onUpdateConfig({
      params: params.map((p, idx) => (idx === i ? { ...p, ...patch } : p)),
    });
  const setHeader = (i: number, patch: Partial<Header>) =>
    onUpdateConfig({
      headers: headers.map((h, idx) => (idx === i ? { ...h, ...patch } : h)),
    });
  const setMapping = (i: number, patch: Partial<Mapping>) =>
    onUpdateConfig({
      response_mappings: mappings.map((m, idx) =>
        idx === i ? { ...m, ...patch } : m
      ),
    });

  return (
    <>
      {/* Request line */}
      <div className="flex items-center justify-between gap-2">
        <span className={sectionTitle}>{t('requestTitle')}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => setCurlOpen(true)}
        >
          <TerminalSquare className="h-3.5 w-3.5" />
          {t('importCurl')}
        </Button>
      </div>

      <div className="grid grid-cols-[6.5rem_1fr] gap-2">
        <div>
          <label className={label}>{t('methodLabel')}</label>
          <Select
            value={method}
            onValueChange={(v) =>
              onUpdateConfig({ method: v === 'POST' ? 'POST' : 'GET' })
            }
          >
            <SelectTrigger className="bg-muted">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="GET">GET</SelectItem>
              <SelectItem value="POST">POST</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className={label}>{t('urlLabel')}</label>
          <Input
            value={cfg.url ?? ''}
            onChange={(e) => onUpdateConfig({ url: e.target.value })}
            placeholder="https://api.example.com/orders/{{vars.order_id}}"
            className="bg-muted font-mono text-xs"
          />
        </div>
      </div>

      <PlaceholderHelp varHints={varHints} t={t} />

      {/* Query params */}
      <KeyValueSection
        title={t('paramsTitle')}
        addLabel={t('addParam')}
        rows={params}
        keyPlaceholder={t('paramKeyPlaceholder')}
        valuePlaceholder="{{contact.phone}}"
        onAdd={() =>
          onUpdateConfig({ params: [...params, { key: '', value: '' }] })
        }
        onChange={setParam}
        onRemove={(i) =>
          onUpdateConfig({ params: params.filter((_, idx) => idx !== i) })
        }
        removeLabel={t('remove')}
      />

      {/* Headers */}
      <div className="space-y-2">
        <span className={sectionTitle}>{t('headersTitle')}</span>
        {headers.map((h, i) => {
          const stored = h.secret && h.value === SECRET_MASK;
          return (
            <div
              key={i}
              className="grid grid-cols-[1fr_1.4fr_auto_auto] items-center gap-2"
            >
              <Input
                value={h.key}
                onChange={(e) => setHeader(i, { key: e.target.value })}
                placeholder={t('headerKeyPlaceholder')}
                className="bg-muted font-mono text-xs"
              />
              {stored ? (
                <div className="border-border bg-muted text-muted-foreground flex h-9 items-center justify-between gap-2 rounded-md border px-2 text-xs">
                  <span className="inline-flex items-center gap-1">
                    <Lock className="h-3 w-3" />
                    {t('storedSecurely')}
                  </span>
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => setHeader(i, { value: '' })}
                  >
                    {t('replaceSecret')}
                  </button>
                </div>
              ) : (
                <Input
                  type={h.secret ? 'password' : 'text'}
                  autoComplete="off"
                  value={h.value}
                  onChange={(e) => setHeader(i, { value: e.target.value })}
                  placeholder={
                    h.secret
                      ? t('secretValuePlaceholder')
                      : t('headerValuePlaceholder')
                  }
                  className="bg-muted font-mono text-xs"
                />
              )}
              <label className="text-muted-foreground inline-flex items-center gap-1.5 text-[11px]">
                <Switch
                  checked={!!h.secret}
                  onCheckedChange={(checked) =>
                    setHeader(i, {
                      secret: checked,
                      // A masked value is meaningless once un-secreted.
                      ...(stored && !checked ? { value: '' } : {}),
                    })
                  }
                  aria-label={t('secretToggle')}
                />
                {t('secretToggle')}
              </label>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label={t('remove')}
                onClick={() =>
                  onUpdateConfig({
                    headers: headers.filter((_, idx) => idx !== i),
                  })
                }
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          );
        })}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs"
          onClick={() =>
            onUpdateConfig({ headers: [...headers, { key: '', value: '' }] })
          }
        >
          <Plus className="h-3.5 w-3.5" />
          {t('addHeader')}
        </Button>
        <p className="text-muted-foreground text-[10px]">{t('secretHelp')}</p>
      </div>

      {/* Body (POST only) */}
      {method === 'POST' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className={sectionTitle}>{t('bodyTitle')}</span>
            <Select
              value={cfg.body_type ?? 'json'}
              onValueChange={(v) => onUpdateConfig({ body_type: v })}
            >
              <SelectTrigger className="bg-muted h-7 w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="json">{t('bodyJson')}</SelectItem>
                <SelectItem value="form">{t('bodyForm')}</SelectItem>
                <SelectItem value="text">{t('bodyText')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Textarea
            value={cfg.body ?? ''}
            onChange={(e) => onUpdateConfig({ body: e.target.value })}
            rows={4}
            placeholder={
              '{"phone": "{{contact.phone}}", "order": "{{vars.order_id}}"}'
            }
            className="bg-muted font-mono text-xs"
          />
        </div>
      )}

      {/* Response → vars */}
      <div className="space-y-2">
        <span className={sectionTitle}>{t('responseTitle')}</span>
        <p className="text-muted-foreground text-[10px]">{t('responseHelp')}</p>
        {mappings.map((m, i) => (
          <div
            key={i}
            className="grid grid-cols-[1fr_1fr_auto] items-center gap-2"
          >
            <Input
              value={m.path}
              onChange={(e) => setMapping(i, { path: e.target.value })}
              placeholder="data.order.status"
              className="bg-muted font-mono text-xs"
            />
            <Input
              value={m.var_key}
              onChange={(e) =>
                setMapping(i, { var_key: sanitizeVarKey(e.target.value) })
              }
              placeholder={t('mappingVarPlaceholder')}
              className="bg-muted font-mono text-xs"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={t('remove')}
              onClick={() =>
                onUpdateConfig({
                  response_mappings: mappings.filter((_, idx) => idx !== i),
                })
              }
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs"
          onClick={() =>
            onUpdateConfig({
              response_mappings: [...mappings, { path: '', var_key: '' }],
            })
          }
        >
          <Plus className="h-3.5 w-3.5" />
          {t('addMapping')}
        </Button>
        <div>
          <label className={label}>{t('statusVarLabel')}</label>
          <Input
            value={cfg.status_var ?? ''}
            onChange={(e) =>
              onUpdateConfig({ status_var: sanitizeVarKey(e.target.value) })
            }
            placeholder="http_status"
            className="bg-muted font-mono text-xs"
          />
        </div>
      </div>

      {/* Branches */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <NextNodeRow
          value={cfg.success_next ?? ''}
          allNodes={allNodes}
          currentKey={currentKey}
          onChange={(v) => onUpdateConfig({ success_next: v })}
          label={t('onSuccess')}
        />
        <NextNodeRow
          value={cfg.failure_next ?? ''}
          allNodes={allNodes}
          currentKey={currentKey}
          onChange={(v) => onUpdateConfig({ failure_next: v })}
          label={t('onFailure')}
        />
      </div>
      <p className="text-muted-foreground text-[10px]">{t('failureHelp')}</p>

      <CurlImportDialog
        open={curlOpen}
        onOpenChange={setCurlOpen}
        onImport={(patch) => onUpdateConfig(patch)}
        t={t}
      />
    </>
  );
}

// ============================================================
// Pieces
// ============================================================

function PlaceholderHelp({
  varHints,
  t,
}: {
  varHints: string[];
  t: ReturnType<typeof useTranslations>;
}) {
  const chips = [
    ...varHints.map((k) => `{{vars.${k}}}`),
    ...HTTP_TEMPLATE_CONTACT_FIELDS.map((f) => `{{contact.${f}}}`),
  ];
  return (
    <div className="text-muted-foreground text-[10px]">
      <p>{t('placeholderHelp')}</p>
      <div className="mt-1 flex flex-wrap gap-1">
        {chips.map((c) => (
          <button
            key={c}
            type="button"
            className="bg-muted hover:text-foreground rounded px-1 font-mono"
            title={t('copyPlaceholder')}
            onClick={() => {
              void navigator.clipboard?.writeText(c).then(
                () => toast.success(t('copied', { value: c })),
                () => {}
              );
            }}
          >
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}

function KeyValueSection({
  title,
  addLabel,
  rows,
  keyPlaceholder,
  valuePlaceholder,
  onAdd,
  onChange,
  onRemove,
  removeLabel,
}: {
  title: string;
  addLabel: string;
  rows: KeyValue[];
  keyPlaceholder: string;
  valuePlaceholder: string;
  onAdd: () => void;
  onChange: (i: number, patch: Partial<KeyValue>) => void;
  onRemove: (i: number) => void;
  removeLabel: string;
}) {
  return (
    <div className="space-y-2">
      <span className={sectionTitle}>{title}</span>
      {rows.map((r, i) => (
        <div
          key={i}
          className="grid grid-cols-[1fr_1.4fr_auto] items-center gap-2"
        >
          <Input
            value={r.key}
            onChange={(e) => onChange(i, { key: e.target.value })}
            placeholder={keyPlaceholder}
            className="bg-muted font-mono text-xs"
          />
          <Input
            value={r.value}
            onChange={(e) => onChange(i, { value: e.target.value })}
            placeholder={valuePlaceholder}
            className="bg-muted font-mono text-xs"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label={removeLabel}
            onClick={() => onRemove(i)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 text-xs"
        onClick={onAdd}
      >
        <Plus className="h-3.5 w-3.5" />
        {addLabel}
      </Button>
    </div>
  );
}

function warningText(
  w: CurlImportWarning,
  t: ReturnType<typeof useTranslations>
): string {
  switch (w.code) {
    case 'unsupported_method':
      return t('curlWarnMethod', { method: w.detail });
    case 'multipart_unsupported':
      return t('curlWarnMultipart');
    case 'ignored_option':
      return t('curlWarnIgnored', { option: w.detail });
    case 'dropped_headers':
      return t('curlWarnDropped', { headers: w.detail });
    case 'multiple_urls':
      return t('curlWarnMultipleUrls');
  }
}

function CurlImportDialog({
  open,
  onOpenChange,
  onImport,
  t,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (patch: Record<string, unknown>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleImport = () => {
    const result = parseCurl(text);
    if (!result.ok) {
      setError(
        result.error === 'no_url'
          ? t('curlErrorNoUrl')
          : result.error === 'unterminated_quote'
            ? t('curlErrorQuote')
            : t('curlErrorEmpty')
      );
      return;
    }
    onImport({ ...result.config });
    for (const w of result.warnings) toast.warning(warningText(w, t));
    toast.success(t('curlImported'));
    setText('');
    setError(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t('curlTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('curlDescription')}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          rows={8}
          placeholder={
            "curl 'https://api.example.com/orders?phone=123' \\\n  -H 'Authorization: Bearer YOUR_TOKEN'"
          }
          className="bg-muted font-mono text-xs"
          autoFocus
        />
        {error && <p className="text-destructive text-xs">{error}</p>}
        <p className="text-muted-foreground text-[10px]">
          {t('curlReplaceHint')}
        </p>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            {t('cancel')}
          </Button>
          <Button type="button" onClick={handleImport} disabled={!text.trim()}>
            {t('curlImportButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
