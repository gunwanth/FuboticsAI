require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

module.exports = {
  // PostgreSQL connection configuration
  postgres: {
    host: process.env.PGHOST || "localhost",
    port: process.env.PGPORT || 5432,
    database: process.env.PGDATABASE || "fubotics",
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "postgres",
    max: process.env.PGMAX || 20,
    idleTimeoutMillis: process.env.PGIDLETIMEOUT || 30000,
    connectionTimeoutMillis: process.env.PGCONNECTIONTIMEOUT || 2000,
  },
  
  // JWT configuration
  jwt: {
    secret: process.env.JWT_SECRET || "please_change_this_secret",
    accessTokenExpiry: process.env.ACCESS_TOKEN_EXPIRY || "15m",
    refreshTokenExpiry: process.env.REFRESH_TOKEN_EXPIRY || "7d",
  },
  
  // Cookie configuration
  cookie: {
    refreshToken: process.env.REFRESH_COOKIE_NAME || "refreshToken",
    maxAge: Number.parseInt(process.env.REFRESH_COOKIE_MAX_AGE_MS || "", 10) || (7 * 24 * 60 * 60 * 1000),
  }
};
