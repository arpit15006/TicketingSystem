import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { ACTION_SCOPE, ROLE_ACTIONS, ErrorCode, type Action, type RoleGrant } from '@ticketing/contracts';
import { AppError } from './errors.js';
import { requireAuth } from './auth.js';

/**
 * What the route must tell us about the thing being acted on. Which fields matter
 * depends on the action's scope, so a route only resolves what its action needs.
 */
export interface ResourceContext {
  resourceId?: string | undefined;
  /** For `own`-scoped actions: who the resource belongs to. */
  ownerUserId?: string | undefined;
}

export type ResourceResolver = (req: FastifyRequest) => Promise<ResourceContext> | ResourceContext;

function grantsAction(grant: RoleGrant, action: Action): boolean {
  return ROLE_ACTIONS[grant.role].includes(action);
}

function isPlatformAdmin(roles: readonly RoleGrant[]): boolean {
  // PRD §9.2 — platform_admin is `*`, global. A platform_admin grant scoped to a
  // single resource is not a global override; it only covers that resource.
  return roles.some((grant) => grant.role === 'platform_admin' && grant.resourceType === null);
}

const forbidden = (action: Action, detail: string): AppError =>
  new AppError(403, ErrorCode.forbidden, `Not permitted to perform ${action}: ${detail}`, { action });

/**
 * ADR-010 — authorization, enforced by the service that owns the resource.
 *
 * The gateway never calls this. It verifies a signature and forwards the request;
 * the decision about who may touch a resource is made here, next to the domain
 * logic that defines what owning it means. The reservation service knows what
 * "owns this hold" means; the gateway does not and should not.
 *
 * Scope is enforced, not just role membership: holding `organizer` does not grant
 * `event:update` on every event, only on the events the grant names.
 */
export function requirePermission(action: Action, resolve?: ResourceResolver): preHandlerAsyncHookHandler {
  return async function permissionCheck(req): Promise<void> {
    const auth = requireAuth(req);

    if (isPlatformAdmin(auth.roles)) return;

    const capable = auth.roles.filter((grant) => grantsAction(grant, action));
    if (capable.length === 0) throw forbidden(action, 'no role grants this action');

    const scope = ACTION_SCOPE[action];

    if (scope === 'global') {
      // The role itself is the permission; no resource to match against.
      return;
    }

    if (resolve === undefined) {
      // A resource-scoped action with no resolver would silently degrade into a
      // global permission. Fail loudly instead — this is a programming error.
      throw new AppError(500, ErrorCode.internal, `Action ${action} is resource-scoped but no resolver was supplied`);
    }

    const resource = await resolve(req);

    if (scope === 'own') {
      // Either the caller owns the resource...
      if (resource.ownerUserId !== undefined && resource.ownerUserId === auth.userId) return;
      // ...or they hold an explicit grant naming it (a co-organizer, a scanner).
      if (
        resource.resourceId !== undefined &&
        capable.some((grant) => grant.resourceType !== null && grant.resourceId === resource.resourceId)
      ) {
        return;
      }
      throw forbidden(action, 'resource belongs to another user');
    }

    // scope is 'event' or 'venue': the grant must name this exact resource.
    if (resource.resourceId === undefined) throw forbidden(action, 'resource could not be identified');

    const matched = capable.some(
      (grant) => grant.resourceType === scope && grant.resourceId === resource.resourceId,
    );
    if (!matched) throw forbidden(action, `no grant for ${scope} ${resource.resourceId}`);
  };
}
