/**
 * Placeholder syntax shared by the "API request" (`http_fetch`) runtime,
 * the save-time validator and the builder form. Client-safe: no Node
 * imports, so validate.ts / the editor can use it without pulling the
 * server-only request code (lib/flows/http-fetch.ts) into the bundle.
 */

/** Contact fields exposed to API-request templates as {{contact.<field>}}. */
export const HTTP_TEMPLATE_CONTACT_FIELDS = [
  'name',
  'phone',
  'email',
  'company',
] as const;
export type HttpTemplateContactField =
  (typeof HTTP_TEMPLATE_CONTACT_FIELDS)[number];

/** `{{vars.key}}` or `{{contact.field}}` (whitespace inside braces allowed). */
export function httpPlaceholderRegex(): RegExp {
  return /\{\{\s*(vars|contact)\.([a-zA-Z0-9_]+)\s*\}\}/g;
}

/** Replace placeholders with a harmless stand-in for static checks. */
export function stripPlaceholders(template: string): string {
  return template.replace(httpPlaceholderRegex(), 'x');
}

/** Same rule collect_input uses for var keys. */
export const VAR_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** RFC 7230 `token` — the only characters legal in a header name. */
export const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
