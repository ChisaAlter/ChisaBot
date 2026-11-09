#!/bin/bash
# Drain the running database before its table-name migration. Never infer an empty database.
conversation_busy_threads() {
  docker exec "$CONTAINER" sh -c '
    database_url=$(cat /run/s6/container_environment/DATABASE_URL)
    table=$(psql "$database_url" -Atc "select coalesce(to_regclass('\''chisabot_local_threads'\''),to_regclass('\''openbot_local_threads'\''))") || exit
    case "$table" in chisabot_local_threads|openbot_local_threads) ;; *) exit 1 ;; esac
    psql "$database_url" -Atc "select count(*) from $table where lock_expires_at > now()"
  '
}
