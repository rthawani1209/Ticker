// Where to go after signing in. Only a path on this site counts: "/\evil.example",
// "/%09/evil.example" and "//evil.example" all look like paths but browsers treat
// them as another host, so the value must start with "/" and a letter or digit, and
// still be on this origin once the browser has resolved it.
export function safeNext(next: string | null, origin: string, fallback = "/trade"): string {
  if (!next || !/^\/[A-Za-z0-9]/.test(next)) return fallback;
  try {
    const url = new URL(next, origin);
    if (url.origin !== origin) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}
