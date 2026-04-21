# ════════════════════════════════════════════════════════════════
# PHPUnit runner image — 公版
#
# 預裝：
#   - php:${PHP_VERSION}-cli（Debian slim）
#   - pcov（coverage 擴充，比 xdebug 快 10×）
#   - phpunit 10.5 phar
#
# 用途：run-project.sh 的 run_unit() 會先建置此 image 一次
#       （依專案 testing.yml 的 php_version 而定），之後重複使用。
#
# 構建：
#   docker build --build-arg PHP_VERSION=8.1 -t testing-pipeline-phpunit:php8.1 .
# ════════════════════════════════════════════════════════════════
ARG PHP_VERSION=8.1
FROM php:${PHP_VERSION}-cli

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ${PHPIZE_DEPS} \
        git \
        unzip \
        ca-certificates \
        curl \
    && docker-php-ext-install -j"$(nproc)" pdo pdo_mysql \
    && pecl install pcov \
    && docker-php-ext-enable pcov \
    && echo "pcov.directory=/project" > /usr/local/etc/php/conf.d/pcov-scope.ini \
    && echo "pcov.enabled=1" >> /usr/local/etc/php/conf.d/pcov-scope.ini \
    && curl -sLo /usr/local/bin/phpunit https://phar.phpunit.de/phpunit-10.5.phar \
    && chmod +x /usr/local/bin/phpunit \
    && apt-get purge -y --auto-remove ${PHPIZE_DEPS} \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /project/.testing/unit

ENTRYPOINT ["phpunit"]
CMD ["--help"]
