import type { Pool } from "pg";

import { ApiError } from "../errors.js";
import type { AccessClaims } from "./tokens.js";

// A bot's API key is made for one league (the practice league when none is named), and
// it can only trade, cancel and read in that league. People signed in normally can ask
// for any league they're in. Returns the league to use, or undefined for "the default".
export async function leagueFor(
  db: Pool,
  user: AccessClaims,
  requested: number | undefined,
): Promise<number | undefined> {
  const key = user.apiKey;
  if (!key) return requested;
  let locked = key.leagueId;
  if (locked === null) {
    const { rows } = await db.query("SELECT id FROM leagues WHERE is_practice ORDER BY id LIMIT 1");
    locked = rows[0]?.id ?? null;
  }
  if (locked === null) throw new ApiError(503, "no_practice_league", "there is no practice league");
  if (requested !== undefined && requested !== locked)
    throw new ApiError(403, "wrong_league", "this key trades in a different league");
  return locked;
}
