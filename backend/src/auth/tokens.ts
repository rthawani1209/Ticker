import { createHash, randomBytes, randomUUID } from "node:crypto";

import { SignJWT, jwtVerify } from "jose";
import type { PoolClient } from "pg";

import type { Db } from "../db/pool.js";

export const ACCESS_TTL_S = 15 * 60;
export const REFRESH_TTL_S = 30 * 24 * 3600;
export const REUSE_GRACE_S = 10;

export type Role = "student" | "professor" | "admin";
export interface AccessClaims { userId: number; role: Role }

export class Tokens {
  private key: Uint8Array;

  constructor(secret: string, private db: Db) {
    this.key = new TextEncoder().encode(secret);
  }

  accessToken(claims: AccessClaims): Promise<string> {
    return new SignJWT({ role: claims.role })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(claims.userId))
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_S}s`)
      .sign(this.key);
  }

  async verifyAccess(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ["HS256"] });
      return { userId: Number(payload.sub), role: payload.role as Role };
    } catch {
      return null;
    }
  }

  // Refresh tokens are random strings; only their hash is stored.
  async issueRefresh(
    userId: number,
    meta: { familyId?: string; userAgent?: string; ip?: string },
    client: Db | PoolClient = this.db,
  ): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await client.query(
      `INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at, user_agent, ip)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5), $6, $7)`,
      [randomUUID(), userId, meta.familyId ?? randomUUID(), sha256(token), REFRESH_TTL_S, meta.userAgent ?? null, meta.ip ?? null],
    );
    return token;
  }

  // Swaps a refresh token for a new one in the same family. Presenting a token that
  // was already used means it was stolen (or the client is badly broken), so the
  // whole family is revoked and both parties have to log in again.
  //
  // The exception is a token used in the last few seconds: two tabs refreshing at
  // the same moment both send it, and the slower one shouldn't log the user out.
  // That request gets its own new token in the family. (We only keep hashes, so we
  // can't hand back the exact successor the first request got.)
  async rotate(token: string, meta: { userAgent?: string; ip?: string }):
    Promise<{ userId: number; token: string } | { error: "invalid" | "reused" }> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT id, user_id, family_id, revoked_at, expires_at < now() AS expired,
                used_at IS NOT NULL AS used, used_at > now() - make_interval(secs => $2) AS in_grace
         FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
        [sha256(token), REUSE_GRACE_S],
      );
      const row = rows[0];
      if (!row || row.revoked_at || row.expired) {
        await client.query("ROLLBACK");
        return { error: "invalid" };
      }
      if (row.used && !row.in_grace) {
        await client.query("UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL", [row.family_id]);
        await client.query("COMMIT");
        return { error: "reused" };
      }
      if (!row.used) await client.query("UPDATE refresh_tokens SET used_at = now() WHERE id = $1", [row.id]);
      const next = await this.issueRefresh(row.user_id, { ...meta, familyId: row.family_id }, client);
      await client.query("COMMIT");
      return { userId: row.user_id, token: next };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async revokeFamilyOf(token: string): Promise<number | null> {
    const { rows } = await this.db.query(
      `UPDATE refresh_tokens SET revoked_at = now()
       WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1) AND revoked_at IS NULL
       RETURNING user_id`,
      [sha256(token)],
    );
    return rows[0]?.user_id ?? null;
  }
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}
