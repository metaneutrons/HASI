#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${HASI_POSTGRES_CONTAINER:?Set the PostgreSQL container name}"
backup_dir=/data/hasi/backups/postgres
recipients=/etc/hasi/backup-recipients.txt
test -s "$recipients"
install -d -m 0700 "$backup_dir"
work_dir=$(mktemp -d "$backup_dir/.pending.XXXXXX")
trap 'rm -rf -- "$work_dir"' EXIT

# The dump is transactionally consistent. It never touches a plaintext host file.
# Use the local database socket; no password is passed in arguments or logs.
docker exec "$HASI_POSTGRES_CONTAINER" \
  pg_dump -U postgres -d hasi --format=custom --no-owner --no-acl \
  | age --recipients-file "$recipients" --output "$work_dir/database.dump.age"
test -s "$work_dir/database.dump.age"
target="$backup_dir/hasi-postgres-$(date -u +%Y%m%dT%H%M%SZ).dump.age"
mv -- "$work_dir/database.dump.age" "$target"
find "$backup_dir" -maxdepth 1 -type f -name 'hasi-postgres-*.dump.age' \
  -mtime +14 -delete
printf 'Encrypted HASI PostgreSQL backup completed.\n'
