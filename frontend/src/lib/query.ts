// Reads one query parameter in the browser. The signed-in screens only render after
// the session loads on the client, so they can read it while setting up state.
export function queryParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(name);
}
