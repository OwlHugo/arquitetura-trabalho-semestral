#!/usr/bin/env bash
# Roteiro da demonstração. Antes: docker compose up --build -d --wait
# Uso: ./demo.sh [quantidade de inscrições, padrão 10]
#
# Mostra, nesta ordem:
#   1. a topologia no RabbitMQ (exchange fanout, duas filas, consumidores)
#   2. a API respondendo 202 na hora para cada inscrição
#   3. as duas réplicas do ingresso dividindo a fila e a notificação recebendo o mesmo evento
#   4. o resultado no banco (status, ingresso, réplica, notificação)
#   5. a idempotência: o mesmo evento reenviado não gera ingresso nem e-mail de novo
set -euo pipefail
cd "$(dirname "$0")"

API="http://localhost:${API_PORTA:-3000}"
PAINEL="http://localhost:${PAINEL_PORTA:-15672}"
QTD="${1:-10}"
VAGAS=8
LOTE="$(date +%H%M%S)"

titulo() { printf '\n\033[1;34m== %s ==\033[0m\n' "$1"; }
sql() { docker compose exec -T postgres psql -U inscricoes -d inscricoes "$@"; }

# Espera (sem sleep) até aparecerem N linhas com o texto nos logs dos serviços.
# O "read -t" só desiste se ficar 90 s sem nenhuma linha nova.
esperar_logs() {
  local texto="$1" quantidade="$2" vistas=0 linha canal pid
  shift 2
  canal="$(mktemp -u)"; mkfifo "$canal"
  docker compose logs -f --no-color "$@" > "$canal" & pid=$!
  while [ "$vistas" -lt "$quantidade" ] && IFS= read -r -t 90 linha; do
    case "$linha" in
      *"$texto"*) vistas=$((vistas + 1)); echo "  $linha" | tee -a "$CAPTURA" ;;
    esac
  done < "$canal"
  kill "$pid" 2>/dev/null || true; rm -f "$canal"
  [ "$vistas" -ge "$quantidade" ] || { echo "Tempo esgotado: vi $vistas de $quantidade linhas." >&2; return 1; }
}
CAPTURA="$(mktemp)"

titulo "0. A API está de pé? (GET /eventos)"
curl -sf --retry 30 --retry-connrefused --retry-all-errors --retry-delay 1 "$API/eventos"
echo

titulo "1. Topologia no RabbitMQ: filas ligadas à exchange fanout 'inscricoes'"
docker compose exec -T rabbitmq rabbitmqctl -q list_bindings source_name destination_name | grep -E '^inscricoes\s' || true
docker compose exec -T rabbitmq rabbitmqctl -q list_queues name consumers messages

titulo "2. Evento novo da demo, com $VAGAS vagas, para mostrar o limite"
EVENTO="$(sql -qtAc "INSERT INTO eventos (nome, data, vagas) VALUES ('Demo $LOTE', current_date + 7, $VAGAS) RETURNING id")"
echo "Evento $EVENTO criado com $VAGAS vagas. Vamos mandar $QTD inscrições."

titulo "3. POST /inscricoes x $QTD (a API grava PENDENTE, publica e responde 202)"
PRIMEIRA=""
for i in $(seq 1 "$QTD"); do
  email="pessoa$i.$LOTE@exemplo.com"
  resposta="$(curl -s -w ' HTTP %{http_code} em %{time_total}s' -X POST "$API/inscricoes" \
    -H 'Content-Type: application/json' \
    -d "{\"eventoId\": $EVENTO, \"nome\": \"Pessoa $i\", \"email\": \"$email\"}")"
  echo "  $resposta"
  [ -z "$PRIMEIRA" ] && PRIMEIRA="$(echo "$resposta" | sed -E 's/.*"id":([0-9]+).*/\1/')"
done

titulo "4. Logs: 2 réplicas de ingresso dividem a fila; notificação recebe o mesmo evento"
esperar_logs ".$LOTE@" $((QTD * 2)) ingresso notificacao

titulo "5. Quantas mensagens cada réplica do ingresso pegou (pelos logs)"
grep -E 'CONFIRMADA|RECUSADA' "$CAPTURA" | awk '{print $1}' | sort | uniq -c

titulo "6. No banco: cada inscrição passou pelos DOIS assinantes"
sql -c "SELECT i.id, i.email, i.status, g.codigo AS ingresso, g.emitido_por AS replica,
               to_char(i.notificada_em, 'HH24:MI:SS') AS notificada_as
          FROM inscricoes i LEFT JOIN ingressos g ON g.inscricao_id = i.id
         WHERE i.evento_id = $EVENTO ORDER BY i.id"
sql -c "SELECT status, COUNT(*) AS total FROM inscricoes WHERE evento_id = $EVENTO GROUP BY status ORDER BY status"

titulo "7. Consulta pela API: GET /inscricoes/$PRIMEIRA"
curl -s "$API/inscricoes/$PRIMEIRA"
echo

titulo "8. Idempotência: reenviando pelo broker o evento da inscrição #$PRIMEIRA"
payload="{\\\"inscricaoId\\\":$PRIMEIRA,\\\"eventoId\\\":$EVENTO,\\\"nome\\\":\\\"Pessoa 1\\\",\\\"email\\\":\\\"pessoa1.$LOTE@exemplo.com\\\"}"
curl -s -u inscricoes:inscricoes -H 'Content-Type: application/json' \
  -X POST "$PAINEL/api/exchanges/%2F/inscricoes/publish" \
  -d "{\"properties\":{\"delivery_mode\":2},\"routing_key\":\"\",\"payload\":\"$payload\",\"payload_encoding\":\"string\"}"
echo
esperar_logs "#$PRIMEIRA já" 2 ingresso notificacao
sql -tAc "SELECT 'ingressos da inscrição #$PRIMEIRA: ' || COUNT(*) FROM ingressos WHERE inscricao_id = $PRIMEIRA"

titulo "9. Filas vazias de novo (tudo processado e confirmado com ack)"
docker compose exec -T rabbitmq rabbitmqctl -q list_queues name consumers messages

rm -f "$CAPTURA"
printf '\nPainel do RabbitMQ: %s (usuário e senha: inscricoes)\n' "$PAINEL"
