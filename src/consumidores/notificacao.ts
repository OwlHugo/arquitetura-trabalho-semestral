import { db } from "../db.js";
import { consumir, FILAS } from "../broker.js";

// CONSUMIDOR 2: notificação. Única tarefa: avisar a pessoa por e-mail que a
// inscrição foi recebida. O "envio" é uma linha no log, para a demo não
// depender de servidor de e-mail.

await consumir(FILAS.notificacao, async (evento) => {
  // Idempotência: só marca (e envia) se ainda não tinha sido notificada.
  const { rowCount } = await db.query(
    "UPDATE inscricoes SET notificada_em = now() WHERE id = $1 AND notificada_em IS NULL",
    [evento.inscricaoId]);

  if (rowCount === 0) {
    const existe = await db.query("SELECT 1 FROM inscricoes WHERE id = $1", [evento.inscricaoId]);
    if (existe.rowCount === 0) throw new Error("inscrição não existe");
    console.log(`inscrição #${evento.inscricaoId} já notificada, ignorando`);
    return;
  }
  console.log(`e-mail para ${evento.email}: "Olá, ${evento.nome}! Recebemos sua inscrição #${evento.inscricaoId}."`);
});
