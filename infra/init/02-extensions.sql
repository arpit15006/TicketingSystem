-- Extensions must be installed by a superuser, so they are created here rather
-- than in a migration.
--
--   citext     — identity: case-insensitive email uniqueness (PRD §7.3)
--   btree_gist — reservation: the GiST EXCLUDE constraint for segmented
--                allocation (PRD §8.4 / ADR-018, Phase 8)
\connect identity_db
CREATE EXTENSION IF NOT EXISTS citext;
GRANT ALL ON SCHEMA public TO identity;

\connect catalog_db
GRANT ALL ON SCHEMA public TO catalog;

\connect reservation_db
CREATE EXTENSION IF NOT EXISTS btree_gist;
GRANT ALL ON SCHEMA public TO reservation;

\connect orders_db
GRANT ALL ON SCHEMA public TO orders;

\connect notification_db
GRANT ALL ON SCHEMA public TO notification;
