-- Up Migration
--
-- PRD §7.3 — identity_db.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  user_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         CITEXT NOT NULL UNIQUE,   -- CITEXT: Alice@x.com and alice@x.com are one account
  password_hash TEXT NOT NULL,            -- argon2id
  full_name     TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- PRD §7.3 specifies PRIMARY KEY (user_id, role, resource_type, resource_id) with
-- resource_type NULL for global roles. Those two requirements cannot both hold:
-- Postgres makes every PRIMARY KEY column NOT NULL, so a global grant could never
-- be stored. The intent — "one grant per (user, role, resource)" — is preserved
-- exactly, using a surrogate key plus two partial unique indexes that treat the
-- global case explicitly rather than encoding it as a sentinel value.
CREATE TABLE role_assignments (
  assignment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  role          TEXT NOT NULL,          -- attendee|organizer|venue_admin|scanner|platform_admin
  resource_type TEXT,                   -- 'event' | 'venue' | NULL for global
  resource_id   UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A grant is either fully global or fully scoped; half a scope is a bug.
  CONSTRAINT role_scope_complete CHECK (
    (resource_type IS NULL AND resource_id IS NULL)
    OR (resource_type IS NOT NULL AND resource_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX role_assignments_global
  ON role_assignments (user_id, role) WHERE resource_type IS NULL;

CREATE UNIQUE INDEX role_assignments_scoped
  ON role_assignments (user_id, role, resource_type, resource_id) WHERE resource_type IS NOT NULL;

CREATE INDEX role_assignments_user ON role_assignments (user_id);

-- ADR-011 — refresh tokens: opaque, hashed at rest, rotated on every use.
-- `family_id` groups a rotation chain so that presenting an already-rotated token
-- can revoke the whole chain rather than just the one token.
CREATE TABLE refresh_tokens (
  token_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  family_id   UUID NOT NULL,
  hash        TEXT NOT NULL UNIQUE,   -- sha256 of the opaque token; the plaintext is never stored
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,            -- set on rotation AND on revocation; both mean "no longer usable"
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user ON refresh_tokens (user_id);

-- Down Migration
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS role_assignments;
DROP TABLE IF EXISTS users;
