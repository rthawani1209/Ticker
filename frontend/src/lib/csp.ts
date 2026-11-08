// The Content-Security-Policy for every page. Scripts only run if they come from this
// site or carry the per-request nonce ('strict-dynamic' lets those load their own
// chunks), so an injected <script> or onclick= does nothing. Styles keep 'unsafe-inline'
// because React and the chart library set style attributes; a style can't run code.
export function contentSecurityPolicy(nonce: string, apiUrl: string, dev: boolean): string {
  const api = new URL(apiUrl);
  const ws = `${api.protocol === "https:" ? "wss:" : "ws:"}//${api.host}`;
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self' ${api.origin} ${ws}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(api.protocol === "https:" ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}
