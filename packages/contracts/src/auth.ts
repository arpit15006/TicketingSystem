/**
 * PRD §9.2 — roles, actions, and how the two relate.
 *
 * Permissions are resource-scoped, never flat globals: an organizer has
 * `event:update` *for events they own*, not for every event. ADR-010 calls the flat
 * version "the one that fails a security review", so the scope travels with the grant.
 */

export const ROLES = ['attendee', 'organizer', 'venue_admin', 'scanner', 'platform_admin'] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = [
  'booking:create',
  'order:read',
  'event:create',
  'event:update',
  'event:publish',
  'venue:create',
  'venue:update',
  'seatmap:write',
  'ticket:scan',
] as const;
export type Action = (typeof ACTIONS)[number];

/** Which actions each role may perform at all, before scope is considered. */
export const ROLE_ACTIONS: Readonly<Record<Role, readonly Action[]>> = {
  attendee: ['booking:create', 'order:read'],
  organizer: ['event:create', 'event:update', 'event:publish'],
  venue_admin: ['venue:create', 'venue:update', 'seatmap:write'],
  scanner: ['ticket:scan'],
  // PRD §9.2 — platform_admin is `*`, global.
  platform_admin: [...ACTIONS],
};

/**
 * How each action is scoped. This is the half that stops a role from being a flat
 * global permission:
 *
 *  - `global` — the grant needs no resource (anyone holding the role may do it)
 *  - `event` / `venue` — the grant must name that exact resource
 *  - `own`   — allowed only on a resource the caller owns
 */
export const ACTION_SCOPE: Readonly<Record<Action, 'global' | 'event' | 'venue' | 'own'>> = {
  'booking:create': 'global',
  'order:read': 'own',
  // Creating an event cannot be scoped to an event that does not exist yet; the
  // creator is then granted `organizer` on that specific event for everything else.
  'event:create': 'global',
  // "Events they own" (PRD §9.2). Ownership is a fact the catalog service holds, so
  // it is checked there rather than mirrored into a grant per event. An explicit
  // `organizer:event:<id>` grant also satisfies these, which is how a co-organizer
  // is added to an event they did not create.
  'event:update': 'own',
  'event:publish': 'own',
  'venue:create': 'global',
  'venue:update': 'venue',
  'seatmap:write': 'venue',
  'ticket:scan': 'event',
};

export type ResourceType = 'event' | 'venue';

/** One row of `role_assignments`, and one entry of the JWT's `roles[]` claim. */
export interface RoleGrant {
  role: Role;
  resourceType: ResourceType | null;
  resourceId: string | null;
}

/**
 * Wire format for a grant inside the JWT: `role` when global, `role:type:id` when
 * scoped. Kept compact because it rides on every request.
 */
export function formatGrant(grant: RoleGrant): string {
  if (grant.resourceType === null || grant.resourceId === null) return grant.role;
  return `${grant.role}:${grant.resourceType}:${grant.resourceId}`;
}

export function parseGrant(raw: string): RoleGrant | null {
  const parts = raw.split(':');
  const role = parts[0];
  if (role === undefined || !(ROLES as readonly string[]).includes(role)) return null;

  if (parts.length === 1) return { role: role as Role, resourceType: null, resourceId: null };

  const resourceType = parts[1];
  const resourceId = parts[2];
  if (resourceType !== 'event' && resourceType !== 'venue') return null;
  if (resourceId === undefined || resourceId === '') return null;

  return { role: role as Role, resourceType, resourceId };
}

/** Claims carried by the RS256 access token (PRD §9.1). */
export interface AccessTokenClaims {
  sub: string;
  roles: string[];
  jti: string;
  iat: number;
  exp: number;
}
