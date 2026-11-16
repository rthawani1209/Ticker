import type { Db } from "./db/pool.js";

export function audit(
  db: Db,
  userId: number | null,
  action: string,
  detail: object = {},
  ip?: string,
): Promise<unknown> {
  return db.query("INSERT INTO audit_log (user_id, action, detail, ip) VALUES ($1, $2, $3, $4)", [
    userId,
    action,
    detail,
    ip ?? null,
  ]);
}

// Login attempts only matter for the 15-minute lockout window, and guesses at made-up
// emails would otherwise pile up forever. Keep a day of them for looking into things.
export async function pruneLoginAttempts(db: Db): Promise<number> {
  const r = await db.query(
    "DELETE FROM audit_log WHERE action = 'login_attempt' AND created_at < now() - interval '1 day'",
  );
  return r.rowCount ?? 0;
}
