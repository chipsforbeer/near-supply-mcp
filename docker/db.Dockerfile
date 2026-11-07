# Demo database: Postgres 15 that creates the server's three roles and its database on first start.
FROM postgres:15
COPY docker/init-roles.sh /docker-entrypoint-initdb.d/10-roles.sh
COPY docker/roles.sql /docker-roles.sql
