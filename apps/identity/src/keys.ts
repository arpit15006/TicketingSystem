import { randomUUID } from 'node:crypto';
import { generateKeyPair, importPKCS8, importSPKI, exportJWK, type JWK, type CryptoKey } from 'jose';
import type { Config } from './config.js';

export interface SigningKeys {
  privateKey: CryptoKey;
  keyId: string;
  /** The public half, in JWKS form. Only ever the public half leaves this process. */
  jwks: { keys: JWK[] };
}

/**
 * PRD §9.1 — RS256, with the public key published at /.well-known/jwks.json.
 *
 * Asymmetric signing is what lets every service verify a token independently
 * (ADR-010) without holding a secret that would also let it *mint* tokens. A shared
 * HMAC secret would turn any service compromise into a token-forgery capability.
 */
export async function loadSigningKeys(config: Config): Promise<SigningKeys> {
  if (config.privateKeyPem !== undefined && config.publicKeyPem !== undefined) {
    const privateKey = await importPKCS8(config.privateKeyPem, 'RS256');
    const publicKey = await importSPKI(config.publicKeyPem, 'RS256', { extractable: true });
    const keyId = config.keyId ?? 'primary';
    return { privateKey, keyId, jwks: { keys: [{ ...(await exportJWK(publicKey)), kid: keyId, alg: 'RS256', use: 'sig' }] } };
  }

  if (config.nodeEnv === 'production') {
    // A generated key would be lost on restart, invalidating every live token and
    // breaking every verifier that cached the JWKS. Refuse rather than degrade.
    throw new Error('JWT_PRIVATE_KEY and JWT_PUBLIC_KEY are required in production');
  }

  const keyId = config.keyId ?? randomUUID();
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  return { privateKey, keyId, jwks: { keys: [{ ...(await exportJWK(publicKey)), kid: keyId, alg: 'RS256', use: 'sig' }] } };
}
