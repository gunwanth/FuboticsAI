const { Pool } = require("pg");
const config = require("../config/database");

// Create PostgreSQL connection pool
const pool = new Pool({
  connectionString: config.postgres.connectionString,
  host: config.postgres.host,
  port: config.postgres.port,
  database: config.postgres.database,
  user: config.postgres.user,
  password: config.postgres.password,
  ssl: config.postgres.ssl,
  max: config.postgres.max,
  idleTimeoutMillis: config.postgres.idleTimeoutMillis,
  connectionTimeoutMillis: config.postgres.connectionTimeoutMillis,
});

pool.on("connect", () => {
  console.log("Connected to PostgreSQL database");
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle PostgreSQL client", {
    message: err?.message,
    code: err?.code,
    detail: err?.detail,
    hint: err?.hint,
  });
  process.exit(-1);
});

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  console.log("Executed query", { text: text.substring(0, 50), duration, rows: res.rowCount });
  return res;
}

async function getClient() {
  return pool.connect();
}

async function initializeDatabase() {
  const fs = require("fs");
  const path = require("path");
  const host = config.postgres.host;
  const port = config.postgres.port;

  try {
    // Quick connectivity check first, gives clearer startup errors in hosted envs.
    await pool.query("SELECT 1");

    const vectorExtensionCheck = await pool.query(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_available_extensions
         WHERE name = 'vector'
       ) AS available,
       EXISTS (
         SELECT 1
         FROM pg_extension
         WHERE extname = 'vector'
       ) AS installed`
    );
    const vectorExtension = vectorExtensionCheck.rows[0] || {};
    if (!vectorExtension.available || !vectorExtension.installed) {
      console.warn(
        'pgvector extension is not installed; continuing with text-only RAG schema.'
      );
    }

    const schemaPath = path.join(__dirname, "..", "database", "schema.sql");
    const schemaSQL = fs.readFileSync(schemaPath, "utf8");

    // Execute the full schema in one statement so PL/pgSQL bodies remain intact.
    await pool.query(schemaSQL);

    console.log("Database schema initialized");
  } catch (err) {
    const isLocalContainerDbMiss =
      err?.code === "ECONNREFUSED" &&
      (host === "localhost" || host === "127.0.0.1" || host === "::1");
    console.error("Error initializing database schema:", {
      message: err?.message,
      code: err?.code,
      detail: err?.detail,
      hint: err?.hint,
      where: err?.where,
      ...(isLocalContainerDbMiss
        ? {
            suggestion:
              `PostgreSQL is unreachable at ${host}:${port}. If this process is running inside Docker, ` +
              "do not use localhost for PGHOST. Use host.docker.internal to reach a database on the host machine, " +
              "or connect to a postgres container on the same Docker network.",
          }
        : {}),
      stack: err?.stack,
    });
    throw err;
  }
}

module.exports = {
  pool,
  query,
  getClient,
  initializeDatabase,
};
