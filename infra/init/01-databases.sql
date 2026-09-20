-- ADR-004 — database per service.
--
-- One Postgres instance hosting separate logical databases with separate
-- credentials, rather than six instances. That is a resource compromise for local
-- development, and it is called out in DECISIONS.md as a known limitation.
--
-- The isolation boundary is still enforced: each role owns exactly one database,
-- no cross-database grants exist, and PUBLIC is revoked so a service that tried to
-- read another's tables would be refused by Postgres rather than by convention.

CREATE ROLE identity    WITH LOGIN PASSWORD 'identity';
CREATE ROLE catalog     WITH LOGIN PASSWORD 'catalog';
CREATE ROLE reservation WITH LOGIN PASSWORD 'reservation';
CREATE ROLE orders      WITH LOGIN PASSWORD 'orders';
CREATE ROLE notification WITH LOGIN PASSWORD 'notification';

CREATE DATABASE identity_db     OWNER identity;
CREATE DATABASE catalog_db      OWNER catalog;
CREATE DATABASE reservation_db  OWNER reservation;
CREATE DATABASE orders_db       OWNER orders;
CREATE DATABASE notification_db OWNER notification;

-- Nobody gets a connection to a database that is not theirs.
REVOKE CONNECT ON DATABASE identity_db     FROM PUBLIC;
REVOKE CONNECT ON DATABASE catalog_db      FROM PUBLIC;
REVOKE CONNECT ON DATABASE reservation_db  FROM PUBLIC;
REVOKE CONNECT ON DATABASE orders_db       FROM PUBLIC;
REVOKE CONNECT ON DATABASE notification_db FROM PUBLIC;

GRANT CONNECT ON DATABASE identity_db     TO identity;
GRANT CONNECT ON DATABASE catalog_db      TO catalog;
GRANT CONNECT ON DATABASE reservation_db  TO reservation;
GRANT CONNECT ON DATABASE orders_db       TO orders;
GRANT CONNECT ON DATABASE notification_db TO notification;
