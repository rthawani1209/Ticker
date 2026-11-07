// Gives a user a role from the command line. This is how the first admin is made;
// after that, admins change roles with PATCH /v1/admin/users/:id.
//
//   DATABASE_URL=... npx tsx scripts/set-role.ts someone@school.edu admin
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";

const [email, role] = process.argv.slice(2);
if (!email || !["student", "professor", "admin"].includes(role ?? "")) {
  console.error("usage: set-role.ts <email> <student|professor|admin>");
  process.exit(2);
}
const db = createPool(loadConfig().DATABASE_URL);
const { rows } = await db.query(
  "UPDATE users SET role = $2 WHERE lower(email) = lower($1) RETURNING id, username, role",
  [email, role],
);
await db.end();
if (!rows[0]) {
  console.error(`no user with email ${email}`);
  process.exit(1);
}
console.log(`${rows[0].username} (id ${rows[0].id}) is now ${rows[0].role}`);
