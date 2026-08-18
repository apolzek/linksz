# Backend do Vaultmarks. Sem `npm install`: o servidor usa so modulos nativos
# do Node (inclusive node:sqlite), entao a imagem e o runtime + o codigo.
FROM node:24-alpine

LABEL org.opencontainers.image.title="Vaultmarks" \
      org.opencontainers.image.description="Organizador de favoritos com busca instantanea" \
      org.opencontainers.image.source="https://github.com/nochaosio/vaultmarks"

WORKDIR /app

COPY server ./server
COPY web ./web

# Usuario sem privilegio + /data como ponto de montagem do banco.
RUN addgroup -S vaultmarks && adduser -S -G vaultmarks vaultmarks \
    && mkdir -p /data \
    && chown -R vaultmarks:vaultmarks /data /app

USER vaultmarks

ENV VAULTMARKS_HOST=0.0.0.0 \
    VAULTMARKS_PORT=8787 \
    VAULTMARKS_DB=/data/vault.db

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.VAULTMARKS_PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/server.js"]
