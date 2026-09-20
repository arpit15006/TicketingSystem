import { SERVICE_TOKEN_HEADER } from '@ticketing/http';
import type { RoleGrant } from '@ticketing/contracts';

export interface IdentityClient {
  /** Grant a resource-scoped role. Throws when identity refuses or is unreachable. */
  grant: (
    args: { userId: string; role: 'organizer' | 'venue_admin'; resourceType: 'event' | 'venue'; resourceId: string },
    requestId: string,
  ) => Promise<RoleGrant[]>;
}

/**
 * Catalog knows who created an event or a venue; identity stores what that lets
 * them do. This is the one call between the two, made over service auth rather
 * than by reaching into identity's tables (ADR-004).
 */
export function createIdentityClient(options: { baseUrl: string; serviceToken: string }): IdentityClient {
  return {
    grant: async (args, requestId) => {
      const response = await fetch(`${options.baseUrl}/internal/users/${args.userId}/roles`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SERVICE_TOKEN_HEADER]: options.serviceToken,
          // PRD §14 — the trace must survive the hop.
          'x-request-id': requestId,
        },
        body: JSON.stringify({ role: args.role, resourceType: args.resourceType, resourceId: args.resourceId }),
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error(`identity grant failed: HTTP ${response.status}`);
      const body = (await response.json()) as { roles: RoleGrant[] };
      return body.roles;
    },
  };
}
