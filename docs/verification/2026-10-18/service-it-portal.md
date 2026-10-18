# Service IT synthetic portal verification

Verified on 2026-10-18 after deployment of `hasi-service-it-demo` (Coolify service UUID `j7goahf7ftvlpvjfaefsdtmj`). The portal is available at [service-it.hasi.metaneutrons.cc](https://service-it.hasi.metaneutrons.cc) behind the existing campus-only Traefik IP allowlist.

The portal serves 271 synthetic Service IT records: 30 legacy demo records plus 241 generated records. Its service, FAQ, and news views read the shared catalog, so future synthetic Service IT fixture additions appear without a fixed-count UI change. Every page identifies its content as fictional, including employee and administrator examples. The article adapter keeps each source title and text inside `main#service-it-document`; the title and paragraph text remain the article’s only semantic content.

The running container reports `healthy` and uses image `sha256:054b87a766399ac666428608d21eecd8395f781cb6fc61cd180393bc5bd80bac` (`linux/amd64`). The rendered Traefik router uses the `https` entrypoint and `service-it-campus-only@docker` middleware. Docker inspection showed no host port bindings (`{}`); container port `4110/tcp` has no published mapping. The Coolify service directory is mode `0700` and its `.env` file is mode `0600`.

Access checks returned:

| Request source | Result |
| --- | ---: |
| Server-local HTTPS request with normal certificate validation | 200; TLS verification succeeded |
| External IPv4 request | 403 |
| External IPv6 request | 403 |
| External IPv4 with `X-Forwarded-For` spoofing | 403 |
| External IPv4 with `Forwarded` spoofing | 403 |
| External IPv6 with `X-Forwarded-For` spoofing | 403 |
| External IPv6 with `Forwarded` spoofing | 403 |

The campus-positive check remains pending because no campus client was used during this verification.
