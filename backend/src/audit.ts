import type { Db } from "./db/pool.js";

export function audit(db: Db, userId: number | null, action: string, detail: object = {}, ip?: string): Promise<unknown> {
  return db.query("INSERT INTO audit_log (user_id, action, detail, ip) VALUES ($1, $2, $3, $4)", [
    userId,
    action,
    detail,
    ip ?? null,
  ]);
}
