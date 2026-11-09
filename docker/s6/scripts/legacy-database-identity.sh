#!/bin/sh
# Existing clusters keep their login and database names; fresh clusters use the product namespace.
# This marker belongs to the database volume, so a later image never guesses a different database.
select_database_identity() {
  PG_IDENTITY_FILE=$1
  if [ -s "$PG_IDENTITY_FILE" ]; then
    IFS=: read -r PG_ROLE PG_DATABASE < "$PG_IDENTITY_FILE"
  elif [ -s "$DATA/PG_VERSION" ]; then
    PG_ROLE=openbot
    PG_DATABASE=openbot
  else
    PG_ROLE=chisabot
    PG_DATABASE=chisabot
  fi
  case "$PG_ROLE:$PG_DATABASE" in
    *[!a-zA-Z0-9_:]*|:*|*:) echo 'postgres-init: invalid stored database identity' >&2; exit 1 ;;
  esac
  if [ ! -s "$PG_IDENTITY_FILE" ]; then
    (umask 077; printf '%s:%s\n' "$PG_ROLE" "$PG_DATABASE" > "$PG_IDENTITY_FILE")
  fi
}
