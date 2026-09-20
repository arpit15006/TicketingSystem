import { SignJWT, jwtVerify } from 'jose';
import { withRedisFallback, type Redis } from '@ticketing/http';

export const queueKey = (eventId: string): string => `wr:${eventId}:queue`;
export const admittedKey = (eventId: string, userId: string): string => `wr:${eventId}:admitted:${userId}`;

export interface QueueStatus {
  /** 1-based position; 0 means "already admitted". */
  position: number;
  total: number;
  estimatedWaitSeconds: number;
  admitted: boolean;
  /** True when Redis was unreachable and the queue let the user straight through. */
  degraded: boolean;
}

export interface AdmissionClaims {
  eventId: string;
  admittedAt: number;
}

/**
 * PRD §12 — join the queue.
 *
 * `ZADD NX` matters: re-joining must NOT reset your score, or a user who refreshes
 * the page loses their place, and anyone who refreshes in a loop is punished for it.
 */
export interface JoinResult {
  joined: boolean;
  degraded: boolean;
}

export async function join(redis: Redis, eventId: string, userId: string): Promise<JoinResult> {
  return withRedisFallback<JoinResult>(
    async () => {
      await redis.zadd(queueKey(eventId), 'NX', Date.now(), userId);
      return { joined: true, degraded: false };
    },
    // ADR-012 — FAIL OPEN. Redis being down must not stop anyone buying a ticket.
    // Seat allocation is still exactly correct without it (INV-7).
    { joined: false, degraded: true },
  );
}

export async function status(
  redis: Redis,
  args: { eventId: string; userId: string; ratePerSecond: number },
): Promise<QueueStatus> {
  return withRedisFallback<QueueStatus>(
    async () => {
      const [rank, total, isAdmitted] = await Promise.all([
        redis.zrank(queueKey(args.eventId), args.userId),
        redis.zcard(queueKey(args.eventId)),
        redis.exists(admittedKey(args.eventId, args.userId)),
      ]);

      if (isAdmitted === 1 || rank === null) {
        return { position: 0, total, estimatedWaitSeconds: 0, admitted: isAdmitted === 1, degraded: false };
      }

      const position = rank + 1;
      return {
        position,
        total,
        estimatedWaitSeconds: Math.ceil(position / Math.max(args.ratePerSecond, 1)),
        admitted: false,
        degraded: false,
      };
    },
    // Degraded: report admitted so the client proceeds rather than spinning.
    { position: 0, total: 0, estimatedWaitSeconds: 0, admitted: true, degraded: true },
  );
}

/**
 * PRD §12 — the admitter. Releases N users per second from the head of the ZSET.
 *
 * `ZPOPMIN` removes and returns atomically, so two admitter instances can run
 * without admitting the same user twice.
 */
export async function admitBatch(
  redis: Redis,
  args: { eventId: string; count: number; ttlSeconds: number },
): Promise<string[]> {
  return withRedisFallback<string[]>(
    async () => {
      const popped = await redis.zpopmin(queueKey(args.eventId), args.count);
      const admitted: string[] = [];
      // zpopmin returns a flat [member, score, member, score, ...] array.
      for (let i = 0; i < popped.length; i += 2) {
        const userId = popped[i];
        if (userId === undefined) continue;
        await redis.set(admittedKey(args.eventId, userId), '1', 'EX', args.ttlSeconds);
        admitted.push(userId);
      }
      return admitted;
    },
    [],
  );
}

/** Events that currently have anyone queued, so the admitter knows where to work. */
export async function activeQueues(redis: Redis): Promise<string[]> {
  return withRedisFallback<string[]>(
    async () => {
      const keys = await redis.keys('wr:*:queue');
      return keys.map((key) => key.split(':')[1] ?? '').filter((eventId) => eventId !== '');
    },
    [],
  );
}

export async function mintAdmissionToken(args: {
  secret: string;
  eventId: string;
  userId: string;
  ttlSeconds: number;
}): Promise<string> {
  const secret = new TextEncoder().encode(args.secret);
  // PRD §12 — claims { eventId, admittedAt, exp: +10min }.
  return new SignJWT({ eventId: args.eventId, admittedAt: Math.floor(Date.now() / 1000) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(args.userId)
    .setIssuedAt()
    .setIssuer('waitingroom')
    .setAudience('ticketing')
    .setExpirationTime(`${args.ttlSeconds}s`)
    .sign(secret);
}

export async function verifyAdmissionToken(args: {
  secret: string;
  token: string;
}): Promise<(AdmissionClaims & { userId: string }) | null> {
  try {
    const { payload } = await jwtVerify(args.token, new TextEncoder().encode(args.secret), {
      issuer: 'waitingroom',
      audience: 'ticketing',
    });
    const eventId = payload['eventId'];
    const admittedAt = payload['admittedAt'];
    if (typeof eventId !== 'string' || typeof admittedAt !== 'number' || typeof payload.sub !== 'string') return null;
    return { eventId, admittedAt, userId: payload.sub };
  } catch {
    return null;
  }
}
