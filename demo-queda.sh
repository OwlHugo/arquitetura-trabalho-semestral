#!/usr/bin/env bash
# Demo extra: o consumidor de notificação cai e a mensagem espera na fila.
# Antes: docker compose up --build -d --wait
set -euo pipefail
cd "$(dirname "$0")"

API="http://localhost:${API_PORTA:-3000}"
EMAIL="queda.$(date +%H%M%S)$RANDOM@exemplo.com"

titulo() { printf '\n\033[1;34m== %s ==\033[0m\n' "$1"; }
# Espera (sem sleep) a primeira linha com o texto no log do serviço.
esperar_log() {
  local linha canal pid achou=0
  canal="$(mktemp -u)"; mkfifo "$canal"
  docker compose logs -f --no-color "$2" > "$canal" & pid=$!
  while [ "$achou" -eq 0 ] && IFS= read -r -t 90 linha; do
    case "$linha" in *"$1"*) echo "  $linha"; achou=1 ;; esac
  done < "$canal"
  kill "$pid" 2>/dev/null || true; rm -f "$canal"
  [ "$achou" -eq 1 ] || { echo "Tempo esgotado esperando: $1" >&2; return 1; }
}
filas() { docker compose exec -T rabbitmq rabbitmqctl -q list_queues name consumers messages; }

titulo "1. Derrubando o consumidor de notificação"
docker compose stop notificacao

titulo "2. Nova inscrição com a notificação fora do ar"
resposta="$(curl -s -X POST "$API/inscricoes" -H 'Content-Type: application/json' \
  -d "{\"eventoId\": 1, \"nome\": \"Teste de Queda\", \"email\": \"$EMAIL\"}")"
echo "  $resposta"
ID="$(echo "$resposta" | sed -E 's/.*"id":([0-9]+).*/\1/')"

titulo "3. A mensagem está guardada na fila da notificação (0 consumidores, 1 mensagem)"
filas

titulo "4. O ingresso não depende da notificação: espera o ingresso processar e consulta"
esperar_log "#$ID " ingresso
curl -s "$API/inscricoes/$ID"
echo

titulo "5. Subindo a notificação de volta: ela pega o que ficou na fila"
docker compose start notificacao
esperar_log "$EMAIL" notificacao
curl -s "$API/inscricoes/$ID"
echo
filas
