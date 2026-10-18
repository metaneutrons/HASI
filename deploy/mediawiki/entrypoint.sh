#!/bin/bash
set -Eeuo pipefail
umask 027

CONFIG_DIR=/var/www/config
LOCAL_SETTINGS="$CONFIG_DIR/LocalSettings.php"
SETTINGS_MARKER="// HASI deployment settings (managed by deploy/mediawiki)."
SETTINGS_REQUIRE="require_once '/usr/local/etc/mediawiki/settings.php';"

fail() {
    printf 'hasi-mediawiki: %s\n' "$1" >&2
    exit 1
}

if [[ "$(id -u)" -ne 0 ]]; then
    fail 'the container entrypoint must run as root to protect the persistent configuration.'
fi

if [[ -z "${WG_SERVER:-}" ]]; then
    fail 'WG_SERVER is required.'
fi

if ! php -r '
$server = getenv("WG_SERVER");
$parts = is_string($server) ? parse_url($server) : false;
if (!is_array($parts)
    || strtolower($parts["scheme"] ?? "") !== "https"
    || empty($parts["host"])
    || isset($parts["user"])
    || isset($parts["pass"])
    || array_key_exists("path", $parts)
    || array_key_exists("query", $parts)
    || array_key_exists("fragment", $parts)) {
    exit(1);
}
$host = $parts["host"];
if (filter_var($host, FILTER_VALIDATE_IP) === false
    && filter_var($host, FILTER_VALIDATE_DOMAIN, FILTER_FLAG_HOSTNAME) === false) {
    exit(1);
}
if (isset($parts["port"]) && ($parts["port"] < 1 || $parts["port"] > 65535)) {
    exit(1);
}
'; then
    fail 'WG_SERVER must be an HTTPS origin with no path, query, or fragment.'
fi

install -d -o root -g www-data -m 0750 "$CONFIG_DIR"
install -d -o www-data -g www-data -m 0755 /var/www/html/images
[[ -r /usr/local/etc/mediawiki/settings.php ]] || fail 'the checked-in MediaWiki settings file is unavailable.'
command -v flock >/dev/null 2>&1 || fail 'flock is required to serialize first-run installation.'

exec 9>>"$CONFIG_DIR/.entrypoint.lock"
chmod 0600 "$CONFIG_DIR/.entrypoint.lock"
flock 9

if [[ -e "$LOCAL_SETTINGS" || -L "$LOCAL_SETTINGS" ]]; then
    [[ -f "$LOCAL_SETTINGS" ]] || fail 'the persistent LocalSettings.php is not a regular file.'
    grep -Fq -- "$SETTINGS_MARKER" "$LOCAL_SETTINGS" \
        && grep -Fq -- "$SETTINGS_REQUIRE" "$LOCAL_SETTINGS" \
        || fail 'the persistent LocalSettings.php is incomplete; refusing to rerun the installer.'
else
    : "${WIKI_DB_PASSWORD_FILE:=/run/secrets/wiki-db-password}"
    : "${WIKI_ADMIN_PASSWORD_FILE:=/run/secrets/wiki-admin-password}"
    export WIKI_DB_PASSWORD_FILE WIKI_ADMIN_PASSWORD_FILE
    [[ -s "$WIKI_DB_PASSWORD_FILE" && -r "$WIKI_DB_PASSWORD_FILE" ]] \
        || fail 'the database password secret file is missing or empty.'
    [[ -s "$WIKI_ADMIN_PASSWORD_FILE" && -r "$WIKI_ADMIN_PASSWORD_FILE" ]] \
        || fail 'the administrator password secret file is missing or empty.'

    php /usr/local/lib/hasi/install.php \
        || fail 'MediaWiki installation failed; Apache has not been started.'

    [[ -s "$LOCAL_SETTINGS" ]] \
        && grep -Fq -- "$SETTINGS_MARKER" "$LOCAL_SETTINGS" \
        && grep -Fq -- "$SETTINGS_REQUIRE" "$LOCAL_SETTINGS" \
        || fail 'MediaWiki did not produce a complete persistent configuration; Apache has not been started.'
fi

chown root:www-data "$CONFIG_DIR" "$LOCAL_SETTINGS"
chmod 0750 "$CONFIG_DIR"
chmod 0640 "$LOCAL_SETTINGS"

flock -u 9
exec 9>&-

apache2ctl configtest >/dev/null || fail 'Apache configuration validation failed.'
exec "$@"
