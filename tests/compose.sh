#!/usr/bin/env bash
# Testa a stack do compose (backend + Caddy com TLS) — o caminho do celular.
#
# Verifica o que realmente importa para a PWA instalar no telefone:
#   - a CA raiz baixavel por HTTP (o passo unico de configuracao)
#   - HTTPS validando contra essa CA, sem -k  => "secure context"
#   - manifest e service worker chegando pelo proxy
#   - a API funcionando e os dados sobrevivendo a um restart
#
# Os testes rodam de um container na mesma rede do compose, em vez de bater na
# porta publicada: funciona igual em Docker local, Docker em VM e CI.
#
# Uso:  bash tests/compose.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

PROJECT="vaultmarks-test-$$"
SITE="localhost"
COMPOSE=(docker compose -p "$PROJECT")
FAILS=0

ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✖\033[0m %s\n' "$*"; FAILS=$((FAILS + 1)); }
info() { printf '\033[1;34m›\033[0m %s\n' "$*"; }

cleanup() {
  info "derrubando a stack de teste"
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! docker info >/dev/null 2>&1; then
  echo "docker indisponivel — pulando teste do compose" >&2
  exit 0
fi

info "subindo a stack (build pode demorar na primeira vez)"
VAULTMARKS_SITE="$SITE" VAULTMARKS_HTTP_PORT=0 VAULTMARKS_HTTPS_PORT=0 \
  "${COMPOSE[@]}" up -d --build >/dev/null 2>&1

# Espera o backend ficar healthy (o Caddy depende disso pra subir).
for _ in $(seq 60); do
  status=$("${COMPOSE[@]}" ps --format '{{.Service}} {{.Status}}' 2>/dev/null | grep '^vaultmarks' || true)
  [[ "$status" == *healthy* ]] && break
  sleep 1
done
[[ "$status" == *healthy* ]] && ok "backend healthy" || bad "backend nao ficou healthy: $status"

NET=$("${COMPOSE[@]}" ps -q caddy | xargs -r docker inspect --format \
  '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')
IP=$("${COMPOSE[@]}" ps -q caddy | xargs -r docker inspect --format \
  '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
[[ -n "$IP" ]] && ok "caddy no ar em $IP" || { bad "caddy nao subiu"; exit 1; }

info "testando o fluxo do celular de dentro da rede"
saida=$(docker run --rm --network "$NET" --entrypoint sh curlimages/curl:latest -c "
R=\"--resolve $SITE:443:$IP --resolve $SITE:80:$IP\"

# 1. baixa a CA raiz por HTTP (o passo unico de configuracao no telefone)
code=\$(curl -s \$R -o /tmp/ca.crt -w '%{http_code}' http://$SITE/root.crt)
grep -q 'BEGIN CERTIFICATE' /tmp/ca.crt 2>/dev/null \
  && echo 'PASS CA raiz servida por HTTP' || echo \"FAIL CA raiz (http \$code)\"

C=\"curl -s \$R --cacert /tmp/ca.crt\"

# 2. HTTPS confiavel: sem isso o service worker nao registra e a PWA nao instala
for p in / /manifest.webmanifest /sw.js /icon-512.png /api/health; do
  st=\$(\$C -o /dev/null -w '%{http_code}' https://$SITE\$p)
  [ \"\$st\" = 200 ] && echo \"PASS https \$p\" || echo \"FAIL https \$p (\$st)\"
done

# 3. sem a CA o certificado tem de ser recusado (prova que e TLS de verdade)
curl -s \$R -o /dev/null https://$SITE/ 2>/dev/null \
  && echo 'FAIL certificado aceito sem CA' || echo 'PASS certificado recusado sem a CA'

# 4. HTTP redireciona para HTTPS
st=\$(curl -s \$R -o /dev/null -w '%{http_code}' http://$SITE/)
[ \"\$st\" = 301 ] && echo 'PASS http redireciona' || echo \"FAIL http redireciona (\$st)\"

# 5. tipo do manifest — errado aqui, o navegador nao oferece instalar
ct=\$(\$C -o /dev/null -w '%{content_type}' https://$SITE/manifest.webmanifest)
case \"\$ct\" in
  application/manifest+json*) echo 'PASS content-type do manifest' ;;
  *) echo \"FAIL content-type do manifest (\$ct)\" ;;
esac

# 6. API completa atraves do proxy, incluindo busca avancada
TOKEN=\$(\$C -X POST https://$SITE/api/auth/register -H 'content-type: application/json' \
  -d '{\"email\":\"t@t.com\",\"username\":\"teste\",\"password\":\"senha123\"}' \
  | sed -n 's/.*\"token\":\"\([^\"]*\)\".*/\1/p')
[ -n \"\$TOKEN\" ] && echo 'PASS registro pela API' || echo 'FAIL registro pela API'

A=\"authorization: Bearer \$TOKEN\"
\$C -o /dev/null -X POST https://$SITE/api/bookmarks -H 'content-type: application/json' \
  -H \"\$A\" -d '{\"url\":\"https://caddyserver.com\",\"title\":\"Caddy\",\"tags\":\"tls,proxy\"}'
\$C -o /dev/null -X POST https://$SITE/api/bookmarks -H 'content-type: application/json' \
  -H \"\$A\" -d '{\"url\":\"https://go.dev\",\"title\":\"Go\",\"tags\":\"go\"}'

\$C \"https://$SITE/api/bookmarks?q=%23tls\" -H \"\$A\" | grep -q '\"title\":\"Caddy\"' \
  && echo 'PASS busca por tag pelo proxy' || echo 'FAIL busca por tag pelo proxy'
\$C \"https://$SITE/api/bookmarks?q=-%23tls\" -H \"\$A\" | grep -q '\"title\":\"Go\"' \
  && echo 'PASS busca com negacao pelo proxy' || echo 'FAIL busca com negacao pelo proxy'
" 2>/dev/null)

while IFS= read -r linha; do
  case "$linha" in
    PASS*) ok "${linha#PASS }" ;;
    FAIL*) bad "${linha#FAIL }" ;;
  esac
done <<< "$saida"

info "reiniciando o backend para conferir a persistencia no volume"
"${COMPOSE[@]}" restart vaultmarks >/dev/null 2>&1
sleep 4

persist=$(docker run --rm --network "$NET" --entrypoint sh curlimages/curl:latest -c "
R=\"--resolve $SITE:443:$IP --resolve $SITE:80:$IP\"
curl -s \$R -o /tmp/ca.crt http://$SITE/root.crt
TOKEN=\$(curl -s \$R --cacert /tmp/ca.crt -X POST https://$SITE/api/auth/login \
  -H 'content-type: application/json' -d '{\"login\":\"teste\",\"password\":\"senha123\"}' \
  | sed -n 's/.*\"token\":\"\([^\"]*\)\".*/\1/p')
curl -s \$R --cacert /tmp/ca.crt https://$SITE/api/bookmarks -H \"authorization: Bearer \$TOKEN\"
" 2>/dev/null)

echo "$persist" | grep -q '"title":"Caddy"' \
  && ok "dados sobrevivem ao restart (volume)" \
  || bad "dados perdidos apos restart"

echo
if [[ $FAILS -eq 0 ]]; then
  printf '\033[32m✔ compose ok\033[0m\n'
else
  printf '\033[31m✖ %d verificacao(oes) falharam no compose\033[0m\n' "$FAILS"
  exit 1
fi
