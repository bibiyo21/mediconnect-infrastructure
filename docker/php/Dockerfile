# Local development image for the Laravel backend (api, worker, scheduler, reverb).
# One PHP version for every artisan / composer command: never run them on the host.
FROM php:8.4-cli-bookworm

COPY --from=mlocati/php-extension-installer:2 /usr/bin/install-php-extensions /usr/local/bin/
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

RUN install-php-extensions \
      pdo_pgsql pgsql redis intl bcmath pcntl sockets zip opcache pcov \
 && apt-get update \
 && apt-get install -y --no-install-recommends git unzip postgresql-client \
 && rm -rf /var/lib/apt/lists/*

ARG UID=1000
ARG GID=1000
# macOS hosts use GID 20, which already exists in Debian: reuse it instead of failing.
RUN (getent group "${GID}" >/dev/null || groupadd -g "${GID}" app) \
 && useradd -m -u "${UID}" -g "${GID}" app

COPY php.ini /usr/local/etc/php/conf.d/zz-mediconnect.ini

USER app
WORKDIR /var/www/backend
