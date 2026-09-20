/**
 * ADR-011 — the `jti` denylist for urgent access-token revocation.
 *
 * PRD §9.1 puts this in Redis. Redis does not enter the system until Phase 5, so
 * this is the same contract backed by an in-process map, swapped for the Redis
 * implementation when Redis arrives. Entries expire with the token, so the map
 * cannot grow without bound.
 *
 * Nothing about seat correctness depends on this (INV-7): it bounds the blast
 * radius of a stolen token, and the 10-minute token TTL is the real guarantee.
 * A single-process denylist is honestly weaker than Redis — it is not shared
 * between replicas — which is exactly why it is behind an interface.
 */
export interface TokenDenylist {
  revoke: (jti: string, expiresAtEpochSeconds: number) => Promise<void>;
  isRevoked: (jti: string) => Promise<boolean>;
}

export function createInMemoryDenylist(): TokenDenylist {
  const revoked = new Map<string, number>();

  const sweep = (): void => {
    const now = Math.floor(Date.now() / 1000);
    for (const [jti, expiry] of revoked) {
      if (expiry <= now) revoked.delete(jti);
    }
  };

  return {
    revoke: async (jti, expiresAtEpochSeconds) => {
      sweep();
      revoked.set(jti, expiresAtEpochSeconds);
    },
    isRevoked: async (jti) => {
      const expiry = revoked.get(jti);
      if (expiry === undefined) return false;
      if (expiry <= Math.floor(Date.now() / 1000)) {
        revoked.delete(jti);
        return false;
      }
      return true;
    },
  };
}
