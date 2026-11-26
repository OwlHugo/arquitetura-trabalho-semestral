-- Roda uma vez, quando o volume do Postgres é criado.
-- Três entidades: evento, inscrição e ingresso.

CREATE TABLE eventos (
  id     SERIAL PRIMARY KEY,
  nome   TEXT    NOT NULL,
  data   DATE    NOT NULL,
  vagas  INTEGER NOT NULL CHECK (vagas > 0)
);

CREATE TABLE inscricoes (
  id             SERIAL PRIMARY KEY,
  evento_id      INTEGER NOT NULL REFERENCES eventos (id),
  nome           TEXT    NOT NULL,
  email          TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'PENDENTE'
                 CHECK (status IN ('PENDENTE', 'CONFIRMADA', 'RECUSADA')),
  notificada_em  TIMESTAMPTZ,            -- preenchido pelo consumidor de notificação
  criada_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (evento_id, email)              -- a mesma pessoa não se inscreve duas vezes no mesmo evento
);

CREATE TABLE ingressos (
  id            SERIAL PRIMARY KEY,
  inscricao_id  INTEGER NOT NULL UNIQUE REFERENCES inscricoes (id),  -- no máximo um ingresso por inscrição
  codigo        TEXT    NOT NULL UNIQUE,
  emitido_por   TEXT    NOT NULL,        -- qual réplica do consumidor emitiu
  emitido_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO eventos (nome, data, vagas) VALUES
  ('Semana de Tecnologia da UFR', '2026-12-07', 100),
  ('Oficina de RabbitMQ',         '2026-12-08', 8);
