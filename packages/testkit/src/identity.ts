import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT, type JWK, type CryptoKey } from 'jose';
import { formatGrant, type RoleGrant } from '@ticketing/contracts';

export interface TestIdentity {
  jwksUri: string;
  issuer: string;
  audience: string;
  mint: (args: { userId?: string; roles?: RoleGrant[]; ttlSeconds?: number; jti?: string }) => Promise<string>;
  /** A bearer header for a plain attendee — the common case in most tests. */
  attendee: (userId?: string) => Promise<Record<string, string>>;
  stop: () => Promise<void>;
}

/**
 * A real RS256 signer with a real JWKS endpoint, for testing services in isolation.
 *
 * The *cryptography* here is genuine: services fetch this JWKS over HTTP and verify
 * signatures for real, so the auth path under test is the production one. What it
 * stands in for is only the identity *service* — Phase 2's end-to-end tests run
 * against the real one through the real gateway.
 */
export async function startTestIdentity(): Promise<TestIdentity> {
  const issuer = 'https://identity.test';
  const audience = 'ticketing';
  const kid = randomUUID();

  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };

  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/.well-known/jwks.json') === true) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test identity did not bind a port');

  const mint: TestIdentity['mint'] = async (args) =>
    new SignJWT({ roles: (args.roles ?? [{ role: 'attendee', resourceType: null, resourceId: null }]).map(formatGrant) })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setSubject(args.userId ?? randomUUID())
      .setJti(args.jti ?? randomUUID())
      .setIssuedAt()
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime(`${args.ttlSeconds ?? 600}s`)
      .sign(privateKey as CryptoKey);

  return {
    jwksUri: `http://127.0.0.1:${address.port}/.well-known/jwks.json`,
    issuer,
    audience,
    mint,
    attendee: async (userId?: string) => ({ authorization: `Bearer ${await mint({ ...(userId === undefined ? {} : { userId }) })}` }),
    stop: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}
