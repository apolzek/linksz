# Caddy com a config ja embutida, em vez de bind-mount do Caddyfile.
#
# Motivos: config imutavel (a imagem carrega a versao exata que roda) e
# funciona em ambientes onde bind-mount de arquivo nao e confiavel — Docker
# com storage driver overlayfs, Docker rodando em VM, CI.
#
# Ao editar o Caddyfile:  docker compose up -d --build caddy
FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile

RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
    || echo "aviso: validacao usa VAULTMARKS_SITE do runtime"
