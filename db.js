// db.js
import sql from "mssql";
import dotenv from "dotenv";
dotenv.config();

const config = {
  server: process.env.DB_SERVER,
  port: Number(process.env.DB_PORT || 1433),
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: process.env.DB_ENCRYPT === "true",
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === "true",
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
};

let pool;
export async function getPool() {
  if (pool?.connected) return pool;
  pool = await sql.connect(config);
  return pool;
}
export { sql };
