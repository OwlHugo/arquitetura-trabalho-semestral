# ADR 001: Inscrições com evento publicado no RabbitMQ

## Contexto

Numa abertura de inscrições muita gente se inscreve ao mesmo tempo. Se a API tivesse que conferir a vaga, gerar o ingresso e mandar o e-mail antes de responder, cada pedido ficaria esperando tudo isso, e uma falha no e-mail derrubaria uma inscrição que já estava certa.

O trabalho pede a organização C: uma API produtora, uma fila dividida entre workers, um evento com dois assinantes e dois consumidores com uma tarefa cada.

## Decisão

A API grava a inscrição como `PENDENTE`, publica o evento `InscricaoRealizada` e responde `202 Accepted`. O resto acontece depois, nos consumidores.

O broker é o RabbitMQ. A API publica numa exchange do tipo **fanout** chamada `inscricoes`. Duas filas estão ligadas nela, uma por assinante: `inscricoes.ingresso` e `inscricoes.notificacao`. A fanout entrega uma cópia para cada fila, então o mesmo evento chega aos dois.

O consumidor de ingresso roda com **duas réplicas na mesma fila**. Numa fila, o RabbitMQ entrega cada mensagem para um consumidor só, então as réplicas dividem o trabalho (competing consumers). Com `prefetch(1)`, cada réplica só pega a próxima mensagem depois de terminar a atual.

Ficamos com exatamente dois consumidores porque é o tamanho que o enunciado pede. A mesma fila faz os dois papéis: é a fila de um assinante do evento e é a fila dividida entre workers. Uma terceira peça (um worker que confirma e depois publica outro evento) também atenderia, mas passaria do tamanho e deixaria mais coisa para explicar.

Escolhemos o RabbitMQ e não o pub/sub do Redis da aula 08 porque o pub/sub do Redis não guarda a mensagem: se o assinante estiver fora do ar, ele perde o evento. No RabbitMQ a mensagem fica na fila (durável) até alguém dar o ack.

## Como a gente evita erro

- **Ack manual.** O consumidor só confirma a mensagem depois de terminar a tarefa. Se ele cair no meio, a mensagem volta para a fila e outra réplica pega.
- **Idempotência.** Como a entrega é "pelo menos uma vez", a mesma mensagem pode chegar duas vezes. O ingresso só trabalha se a inscrição ainda estiver `PENDENTE`, e a tabela `ingressos` tem `UNIQUE (inscricao_id)`. A notificação só envia se `notificada_em` estiver vazio.
- **Vagas com duas réplicas.** As duas réplicas podem processar inscrições do mesmo evento no mesmo instante. Elas travam a linha do evento com `SELECT ... FOR UPDATE` antes de contar os ingressos, então uma espera a outra e o evento não passa do limite.
- **Fila de falhas.** Se a tarefa der erro, o consumidor faz `nack` sem devolver para a fila, e o RabbitMQ manda a mensagem para `inscricoes.falhas`. Assim uma mensagem com problema não fica voltando para sempre.

## Consequências

A API responde em poucos milissegundos e não depende dos consumidores estarem de pé. Se a notificação cair, as mensagens ficam esperando na fila e saem quando ela volta (o `demo-queda.sh` mostra isso). Para aguentar mais volume, basta subir mais réplicas do ingresso.

Em troca, o sistema passa a ter **consistência eventual**: logo depois do `POST` a inscrição ainda aparece como `PENDENTE`, e o cliente consulta o `GET /inscricoes/:id` para ver o resultado. Também ganhamos um container a mais para cuidar (o RabbitMQ).

Ficou um ponto de fora, por simplicidade. A API grava no banco e depois publica. Se o RabbitMQ cair exatamente entre as duas coisas, a inscrição fica `PENDENTE` sem mensagem. A solução conhecida é o padrão *outbox* (gravar o evento numa tabela na mesma transação e um processo separado publicar), que deixamos como melhoria.
