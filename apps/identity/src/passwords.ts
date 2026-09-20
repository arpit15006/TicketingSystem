import { hash, verify } from '@node-rs/argon2';

/**
 * PRD §7.3 — argon2id.
 *
 * argon2id is memory-hard, which is what makes large-scale GPU cracking expensive
 * in a way that bcrypt's CPU-bound work factor no longer is. The parameters below
 * are the OWASP baseline (19 MiB, 2 iterations, parallelism 1).
 */
// `Algorithm` is an ambient const enum, which `verbatimModuleSyntax` cannot import,
// so the value is written literally: Algorithm.Argon2id === 2. A test asserts the
// emitted hash actually carries the `$argon2id$` prefix, so this is a checked fact
// rather than a comment that could quietly go stale.
const ARGON2ID = 2;
const OPTIONS = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, OPTIONS);
}

export async function verifyPassword(plaintext: string, storedHash: string): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, OPTIONS);
  } catch {
    // A malformed or truncated hash must read as "wrong password", never as an
    // error that a caller might accidentally treat as success.
    return false;
  }
}
