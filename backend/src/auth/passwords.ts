import argon2 from "argon2";

// OWASP's recommended argon2id settings (19 MiB, 2 passes).
const OPTIONS = { type: argon2.argon2id as 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export const hashPassword = (password: string) => argon2.hash(password, OPTIONS);

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

// Verified against when the email doesn't exist, so a login takes the same time either way.
let dummy: Promise<string> | null = null;
export const dummyHash = () => (dummy ??= hashPassword("not-a-real-password"));
