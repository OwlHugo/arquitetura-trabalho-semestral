import amqp, { type ConfirmChannel } from "amqplib";

// Tudo o que é RabbitMQ fica neste arquivo: conexão, exchange, filas,
// publicação e consumo. A API e os consumidores só chamam as funções daqui.

// O evento que a API publica depois de gravar uma inscrição.
export type InscricaoRealizada = {
  inscricaoId: number;
  eventoId: number;
  nome: string;
  email: string;
};

// Exchange do tipo fanout: entrega uma cópia de cada mensagem para TODAS as
// filas ligadas a ela. É isso que faz o evento ter dois assinantes.
export const EXCHANGE = "inscricoes";

// Uma fila por assinante. Para criar um terceiro assinante, basta pôr uma
// fila nova aqui e escrever o consumidor dela (veja o README).
export const FILAS = {
  ingresso: "inscricoes.ingresso",
  notificacao: "inscricoes.notificacao",
};

// Mensagem que deu erro no consumidor não volta para a fila (evita laço
// infinito): vai para a fila de falhas, onde dá para olhar no painel.
const EXCHANGE_FALHAS = "inscricoes.falhas";
const FILA_FALHAS = "inscricoes.falhas";

// Conecta e declara a topologia. Todos os processos declaram tudo: as
// declarações são idempotentes, e assim a fila já existe antes da primeira
// publicação, não importa quem subiu primeiro.
export async function conectar(): Promise<ConfirmChannel> {
  const conexao = await amqp.connect(process.env.RABBITMQ_URL!);
  // Se o broker cair, o processo sai e o Docker sobe de novo (restart no compose).
  conexao.on("close", () => {
    console.error("conexão com o RabbitMQ fechou, saindo");
    process.exit(1);
  });

  const canal = await conexao.createConfirmChannel();
  await canal.assertExchange(EXCHANGE, "fanout", { durable: true });
  await canal.assertExchange(EXCHANGE_FALHAS, "fanout", { durable: true });
  await canal.assertQueue(FILA_FALHAS, { durable: true });
  await canal.bindQueue(FILA_FALHAS, EXCHANGE_FALHAS, "");

  for (const fila of Object.values(FILAS)) {
    await canal.assertQueue(fila, { durable: true, deadLetterExchange: EXCHANGE_FALHAS });
    await canal.bindQueue(fila, EXCHANGE, "");
  }
  return canal;
}

// Publica o evento e espera o broker confirmar que recebeu (confirm channel).
export async function publicar(canal: ConfirmChannel, evento: InscricaoRealizada) {
  canal.publish(EXCHANGE, "", Buffer.from(JSON.stringify(evento)), {
    persistent: true, // a mensagem sobrevive a um restart do RabbitMQ
    contentType: "application/json",
    type: "InscricaoRealizada",
    messageId: `inscricao-${evento.inscricaoId}`,
  });
  await canal.waitForConfirms();
}

// Consome uma fila com ack manual: só confirma depois que a tarefa terminou.
// Se o processo morrer no meio, a mensagem volta para a fila e outro pega.
export async function consumir(fila: string, tarefa: (evento: InscricaoRealizada) => Promise<void>) {
  const canal = await conectar();
  // Uma mensagem por vez para cada réplica: quem está livre pega a próxima.
  await canal.prefetch(1);

  await canal.consume(fila, async (msg) => {
    if (!msg) return;
    const evento = JSON.parse(msg.content.toString()) as InscricaoRealizada;
    try {
      await tarefa(evento);
      canal.ack(msg);
    } catch (erro) {
      console.error(`falha na inscrição #${evento.inscricaoId}, mandando para ${FILA_FALHAS}:`, erro);
      canal.nack(msg, false, false);
    }
  });
  console.log(`ouvindo a fila ${fila}`);
}
