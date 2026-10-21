# HASI Wissen MediaWiki

This container runs the pinned MediaWiki 1.43.11 image behind Coolify Traefik
on internal port 80. Build it from this directory. Configure Coolify to route
the canonical HTTPS host to the container's port 80.

Set `WG_SERVER` to the public HTTPS origin, for example
`https://wiki.example.edu`. It must not contain a path, query, or fragment.
Articles use `/wiki/$1`, the API stays at `/api.php`, and the main page is
served at `/` and `/wiki/` from the dedicated `HASI_Wissen` landing page. Other
articles, including `Main Page`, remain available through `/wiki/$1`.

Attach persistent volumes at `/var/www/config` and `/var/www/html/images`.
The first volume stores MediaWiki's generated `LocalSettings.php`; the entrypoint
restricts it to root and the Apache `www-data` group with mode `0640`. The images
volume preserves files independently of the container image. MediaWiki loads
the config from the persistent path outside the web root.

Provide these read-only secret files through the container's `/run/secrets`:

- `/run/secrets/wiki-db-password` for the MariaDB user `wiki`
- `/run/secrets/wiki-admin-password` for the initial `wikiadmin` sysop account

The corresponding environment variables are `WIKI_DB_PASSWORD_FILE` and
`WIKI_ADMIN_PASSWORD_FILE`; each defaults to the path above. The database host
defaults to `wiki-database` and can be set with `WIKI_DB_HOST`. The database and
user names are both `wiki`. The installer reads password file contents inside
PHP and supplies them to MediaWiki without placing the values in the operating
system process arguments. Changing the secret files after installation does not
change the database or administrator credentials.

Startup installs only when `/var/www/config/LocalSettings.php` is absent. It
does not rerun installation when a config exists and will refuse to start if
that config lacks the final settings marker. The installer never drops or
overwrites the database. Apache starts only after the persistent config is
complete and protected.

Anonymous reads are enabled. Editing is limited to sysops; account creation,
email, and uploads are disabled. The wiki sends `noindex,nofollow` robot policy.
Its Apache/PHP settings use six workers and a 192 MiB PHP memory limit for a
small deployment. The container health check queries MediaWiki API site info
locally and does not read secret files.

Import the synthetic knowledge seed separately after the first successful
startup. The seed should provide the `HASI Wissen` landing page and set
`MediaWiki:Mainpage` to it;
the startup route already targets that title. Network access controls belong on
the parent-managed proxy and its private network.
