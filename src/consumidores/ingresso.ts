import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { db } from "../db.js";
import { consumir, FILAS } from "../broker.js";

// CONSUMIDOR 1: ingresso. Única tarefa: decidir se tem vaga e emitir o ingresso.
// Roda com 2 réplicas na MESMA fila (competing consumers): o RabbitMQ entrega
// cada mensagem para uma réplica só, então as duas dividem o trabalho.

const replica = hostname(); // no Docker, o hostname é o id do container

await consumir(FILAS.ingresso, async (evento) => {
  const cliente = await db.connect();
  try {
    await cliente.query("BEGIN");

    // Trava a linha do evento até o COMMIT. Com duas réplicas trabalhando ao
    // mesmo tempo, só uma conta as vagas por vez, e o evento não lota além do limite.
    const { rows: [ev] } = await cliente.query(
      "SELECT vagas FROM eventos WHERE id = $1 FOR UPDATE", [evento.eventoId]);
    const { rows: [inscricao] } = await cliente.query(
      "SELECT status FROM inscricoes WHERE id = $1", [evento.inscricaoId]);
    if (!ev || !inscricao) throw new Error("evento ou inscrição não existe");

    // Idempotência: se a mesma mensagem chegar de novo, não emite outro ingresso.
    if (inscricao.status !== "PENDENTE") {
      await cliente.query("COMMIT");
      console.log(`[${replica}] inscrição #${evento.inscricaoId} já processada (${inscricao.status}), ignorando`);
      return;
    }

    const { rows: [{ emitidos }] } = await cliente.query(
      `SELECT COUNT(*)::int AS emitidos FROM ingressos g
         JOIN inscricoes i ON i.id = g.inscricao_id WHERE i.evento_id = $1`, [evento.eventoId]);

    if (emitidos < ev.vagas) {
      const codigo = `ING-${evento.eventoId}-${randomBytes(3).toString("hex").toUpperCase()}`;
      await cliente.query(
        "INSERT INTO ingressos (inscricao_id, codigo, emitido_por) VALUES ($1, $2, $3)",
        [evento.inscricaoId, codigo, replica]);
      await cliente.query("UPDATE inscricoes SET status = 'CONFIRMADA' WHERE id = $1", [evento.inscricaoId]);
      await cliente.query("COMMIT");
      console.log(`[${replica}] inscrição #${evento.inscricaoId} (${evento.email}) CONFIRMADA, ingresso ${codigo}`);
    } else {
      await cliente.query("UPDATE inscricoes SET status = 'RECUSADA' WHERE id = $1", [evento.inscricaoId]);
      await cliente.query("COMMIT");
      console.log(`[${replica}] inscrição #${evento.inscricaoId} (${evento.email}) RECUSADA, evento lotado`);
    }
  } catch (erro) {
    await cliente.query("ROLLBACK");
    throw erro; // o consumir() faz o nack e a mensagem vai para a fila de falhas
  } finally {
    cliente.release();
  }
});
