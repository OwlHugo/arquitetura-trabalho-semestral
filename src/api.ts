import express from "express";
import { db } from "./db.js";
import { conectar, publicar } from "./broker.js";

// A API PRODUTORA: três rotas. Ela grava a inscrição como PENDENTE, publica
// o evento InscricaoRealizada e responde na hora (202). Quem decide a vaga e
// manda o e-mail são os consumidores, depois.

const canal = await conectar();
const app = express();
app.use(express.json());

// Rota 1: lista os eventos com as vagas que ainda sobram.
app.get("/eventos", async (_req, res) => {
  const { rows } = await db.query(`
    SELECT e.id, e.nome, e.data::text AS data, e.vagas,
           e.vagas - COUNT(g.id)::int AS vagas_restantes
      FROM eventos e
      LEFT JOIN inscricoes i ON i.evento_id = e.id
      LEFT JOIN ingressos g  ON g.inscricao_id = i.id
     GROUP BY e.id
     ORDER BY e.id`);
  res.json(rows);
});

// Rota 2: cria a inscrição e publica o evento.
app.post("/inscricoes", async (req, res) => {
  const { eventoId, nome, email } = req.body ?? {};
  if (!Number.isInteger(eventoId) || !nome || !email) {
    res.status(400).json({ erro: "Informe eventoId (número), nome e email." });
    return;
  }

  const evento = await db.query("SELECT id FROM eventos WHERE id = $1", [eventoId]);
  if (evento.rowCount === 0) {
    res.status(404).json({ erro: `Evento ${eventoId} não existe.` });
    return;
  }

  let inscricao;
  try {
    const { rows } = await db.query(
      `INSERT INTO inscricoes (evento_id, nome, email) VALUES ($1, $2, $3)
       RETURNING id, evento_id AS "eventoId", nome, email, status`,
      [eventoId, nome, email],
    );
    inscricao = rows[0];
  } catch (erro: any) {
    if (erro.code === "23505") { // violou o UNIQUE (evento_id, email)
      res.status(409).json({ erro: "Este e-mail já está inscrito neste evento." });
      return;
    }
    throw erro;
  }

  await publicar(canal, { inscricaoId: inscricao.id, eventoId, nome, email });
  console.log(`inscrição #${inscricao.id} gravada como PENDENTE e evento InscricaoRealizada publicado`);

  // 202 Accepted: recebemos, mas o processamento ainda vai acontecer.
  res.status(202).location(`/inscricoes/${inscricao.id}`).json(inscricao);
});

// Rota 3: consulta a inscrição. Mostra o resultado dos dois consumidores:
// o status e o ingresso (consumidor de ingresso) e notificadaEm (consumidor de notificação).
app.get("/inscricoes/:id", async (req, res) => {
  const { rows } = await db.query(
    `SELECT i.id, i.evento_id AS "eventoId", e.nome AS evento, i.nome, i.email, i.status,
            g.codigo AS ingresso, i.notificada_em AS "notificadaEm"
       FROM inscricoes i
       JOIN eventos e ON e.id = i.evento_id
       LEFT JOIN ingressos g ON g.inscricao_id = i.id
      WHERE i.id = $1`,
    [Number(req.params.id) || 0],
  );
  if (rows.length === 0) {
    res.status(404).json({ erro: "Inscrição não encontrada." });
    return;
  }
  res.json(rows[0]);
});

app.listen(3000, () => console.log("API ouvindo na porta 3000"));
