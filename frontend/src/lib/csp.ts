// The Content-Security-Policy for every page. Scripts only run if they come from this
// site or carry the per-request nonce ('strict-dynamic' lets those load their own
// chunks), so an injected <script> or onclick= does nothing. Styles keep 'unsafe-inline'
// because React and the chart library set style attributes; a style can't run code.
export function contentSecurityPolicy(
  nonce: string,
  apiUrl: string, // "" when the API is reached through this site
  wsUrl: string,
  dev: boolean,
): string {
  const api = apiUrl ? new URL(apiUrl).origin : "";
  const ws = new URL(wsUrl, "ws://localhost").origin;
  const secure = !dev && (apiUrl === "" || apiUrl.startsWith("https:"));
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self'${api ? ` ${api}` : ""} ${ws}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(secure ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}
