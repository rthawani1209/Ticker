// Bot API keys: "tk_<prefix>_<secret>". The prefix finds the row, the secret is
// checked against a SHA-256 hash in constant time. The secrets are 32 random bytes,
// so a fast hash is enough here; slow hashing is for human-chosen passwords.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Db } from "../db/pool.js";
import type { Role } from "./tokens.js";

export interface KeyLimits {
  id: number;
  leagueId: number | null;
  maxOrderQty: number;
  ordersPerSecond: number;
}

const hash = (secret: string) => createHash("sha256").update(secret).digest();
const KEY = /^tk_([A-Za-z0-9]{10})_([A-Za-z0-9_-]{43})$/;

export const isApiKey = (token: string) => token.startsWith("tk_");
export const keyPrefix = (token: string) => KEY.exec(token)?.[1] ?? null;

export class ApiKeys {
  private botsEnabled = { value: true, at: 0 };

  constructor(private db: Db) {}

  static generate() {
    const prefix = randomBytes(8).toString("hex").slice(0, 10);
    const secret = randomBytes(32).toString("base64url");
    return { prefix, secret, key: `tk_${prefix}_${secret}` };
  }

  async verify(token: string): Promise<{ userId: number; role: Role; key: KeyLimits } | null> {
    const m = KEY.exec(token);
    if (!m) return null;
    const { rows } = await this.db.query(
      `SELECT k.id, k.user_id, k.league_id, k.secret_hash, k.max_order_qty, k.orders_per_second,
              u.role::text AS role
       FROM api_keys k JOIN users u ON u.id = k.user_id
       WHERE k.prefix = $1 AND k.revoked_at IS NULL`,
      [m[1]],
    );
    const row = rows[0];
    if (!row || !timingSafeEqual(row.secret_hash, hash(m[2]!))) return null;
    // Recording use once a minute is plenty, and keeps a busy bot from writing every request.
    await this.db.query(
      `UPDATE api_keys SET last_used_at = now()
       WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [row.id],
    );
    return {
      userId: row.user_id,
      role: row.role,
      key: {
        id: row.id,
        leagueId: row.league_id,
        maxOrderQty: row.max_order_qty,
        ordersPerSecond: row.orders_per_second,
      },
    };
  }

  static secretHash(secret: string) {
    return hash(secret);
  }

  // The admin kill switch. Read at most once a second per gateway.
  async enabled(): Promise<boolean> {
    if (Date.now() - this.botsEnabled.at < 1000) return this.botsEnabled.value;
    const { rows } = await this.db.query("SELECT value FROM settings WHERE key = 'bots_enabled'");
    this.botsEnabled = { value: rows[0]?.value !== false, at: Date.now() };
    return this.botsEnabled.value;
  }

  forgetEnabled() {
    this.botsEnabled.at = 0;
  }
}
