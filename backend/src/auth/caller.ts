import type { FastifyRequest } from "fastify";

import type { KeyLimits } from "./api-keys.js";
import type { AccessClaims } from "./tokens.js";

// Who sent a request, from a verified token only. Rate limits run before
// authentication, so they need this too; keying a limit on an unchecked token let
// anyone pick a fresh bucket per request (or someone else's).
export type Caller =
  | { kind: "key"; userId: number; role: AccessClaims["role"]; key: KeyLimits }
  | { kind: "user"; claims: AccessClaims }
  | { kind: "bad_key" }
  | null;

// The rate-limit bucket for a caller: a verified key or user, otherwise the IP.
export function callerKey(req: FastifyRequest, caller: Caller): string {
  if (caller?.kind === "key") return `k${caller.key.id}`;
  if (caller?.kind === "user") return `u${caller.claims.userId}`;
  return req.ip;
}
