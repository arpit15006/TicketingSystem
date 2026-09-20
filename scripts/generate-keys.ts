/**
 * Generates the RS256 keypair identity signs access tokens with.
 *
 * Without a configured pair, identity generates one at boot — which means every
 * restart invalidates every live token AND every JWKS any other service has
 * cached, producing a burst of 401s across the platform. That is why production
 * refuses to start without one, and why a stack meant to survive `docker compose
 * restart` should set these.
 *
 *   pnpm keys:generate >> .env
 */
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { randomUUID } from 'node:crypto';

const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });

const toEnvLine = (name: string, pem: string): string => `${name}="${pem.trimEnd().replace(/\n/g, '\\n')}"`;

console.log(`# Generated ${new Date().toISOString()} by pnpm keys:generate`);
console.log(toEnvLine('JWT_PRIVATE_KEY', await exportPKCS8(privateKey)));
console.log(toEnvLine('JWT_PUBLIC_KEY', await exportSPKI(publicKey)));
console.log(`JWT_KEY_ID=${randomUUID()}`);
