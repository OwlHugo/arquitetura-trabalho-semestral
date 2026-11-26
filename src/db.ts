import pg from "pg";

// Uma conexão (pool) com o PostgreSQL, usada pela API e pelos consumidores.
// O endereço vem do compose.yaml.
export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
