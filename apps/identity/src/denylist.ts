/**
 * ADR-011 — the `jti` denylist for urgent access-token revocation.
 *
 * Nothing about seat correctness depends on this (INV-7). It bounds the blast
 * radius of a stolen token within its 10-minute lifetime, which is the real
 * guarantee; the denylist just shortens that window when someone logs out.
 *
 * Two implementations: Redis (shared across replicas, what production uses) and
 * an in-process map kept for unit tests and single-process runs.
 */
export interface TokenDenylist {
  revoke: (jti: string, expiresAtEpochSeconds: number) => Promise<void>;
  isRevoked: (jti: string) => Promise<boolean>;
}

/**
 * The Redis-backed denylist. PRD §9.1 — TTL equal to the token's remaining life,
 * so entries expire exactly when they stop mattering and the key space is bounded.
 *
 * FAIL OPEN on a Redis outage: `isRevoked` answers "not revoked" and the token
 * remains valid until it expires on its own. That is the ADR-011 trade-off stated
 * plainly — up to ten minutes of staleness on a revoked session. Failing closed
 * would mean a Redis blip logs out every user of the platform, which is a far worse
 * outcome than a bounded window during which a logout has not yet taken effect.
 */
export function createRedisDenylist(redis: {
  set: (key: string, value: string, mode: 'EX', ttl: number) => Promise<unknown>;
  exists: (key: string) => Promise<number>;
}): TokenDenylist {
  const key = (jti: string): string => `denylist:jti:${jti}`;

  return {
    revoke: async (jti, expiresAtEpochSeconds) => {
      const ttl = Math.max(1, expiresAtEpochSeconds - Math.floor(Date.now() / 1000));
      try {
        await redis.set(key(jti), '1', 'EX', ttl);
      } catch {
        // Nothing to escalate to: the token still expires on schedule.
      }
    },
    isRevoked: async (jti) => {
      try {
        return (await redis.exists(key(jti))) === 1;
      } catch {
        return false;
      }
    },
  };
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
