// Role checks. The role in the access token can be up to 15 minutes old, so routes
// that need a professor or admin read the current role from the database: taking
// someone's professor role away works on their next request, not at their next refresh.
import type { FastifyReply, FastifyRequest } from "fastify";

import type { Db } from "../db/pool.js";
import type { Role } from "./tokens.js";

export function requireRole(db: Db, ...allowed: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const { rows } = await db.query("SELECT role::text AS role FROM users WHERE id = $1", [
      req.user.userId,
    ]);
    const role = rows[0]?.role as Role | undefined;
    if (!role || !allowed.includes(role)) {
      await reply
        .code(403)
        .send({ error: "forbidden", message: `needs the ${allowed.join(" or ")} role` });
      return;
    }
    req.user = { ...req.user, role };
  };
}
