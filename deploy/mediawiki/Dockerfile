FROM mediawiki:1.43.11@sha256:76b3d47b50c4e4a78f82e814917421cb62c49b0c56b4a0f981cd74e2bddd10ac

ENV WIKI_DB_HOST=wiki-database \
    MW_CONFIG_FILE=/var/www/config/LocalSettings.php

RUN a2enmod rewrite \
    && install -d -o root -g root -m 0755 /usr/local/lib/hasi \
    && install -d -o root -g root -m 0755 /usr/local/etc/mediawiki \
    && install -d -o root -g www-data -m 0750 /var/www/config

COPY --chown=0:0 apache-short-url.conf /etc/apache2/conf-available/short-url.conf
COPY --chown=0:0 apache-mpm-prefork.conf /etc/apache2/mods-available/mpm_prefork.conf
COPY --chown=0:0 php-memory.ini /usr/local/etc/php/conf.d/zz-hasi-memory.ini
COPY --chown=0:0 entrypoint.sh /usr/local/bin/hasi-entrypoint
COPY --chown=0:0 install.php /usr/local/lib/hasi/install.php
COPY --chown=0:0 settings.php /usr/local/etc/mediawiki/settings.php

RUN chmod 0755 /usr/local/bin/hasi-entrypoint \
    && chmod 0644 /usr/local/lib/hasi/install.php /usr/local/etc/mediawiki/settings.php \
    && apache2ctl configtest

VOLUME ["/var/www/config", "/var/www/html/images"]
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD ["php", "-r", "$context = stream_context_create(['http' => ['header' => \"X-Forwarded-Proto: https\\r\\n\"]]); $body = @file_get_contents('http://127.0.0.1/api.php?action=query&meta=siteinfo&format=json', false, $context); exit($body !== false && str_contains($body, '\"general\"') ? 0 : 1);"]

ENTRYPOINT ["/usr/local/bin/hasi-entrypoint"]
CMD ["apache2-foreground"]
