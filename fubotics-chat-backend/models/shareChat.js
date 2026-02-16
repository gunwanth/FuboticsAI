const db = require("../db");

const shareChatModel = {
  async getBySessionId(sessionId) {
    const result = await db.query(
      "SELECT id, session_id, token, created_by, is_active, created_at FROM shared_chats WHERE session_id = $1",
      [sessionId]
    );
    return result.rows[0] || null;
  },

  async getByToken(token) {
    const result = await db.query(
      "SELECT id, session_id, token, created_by, is_active, created_at FROM shared_chats WHERE token = $1 AND is_active = TRUE",
      [token]
    );
    return result.rows[0] || null;
  },

  async create(sessionId, userId) {
    const result = await db.query(
      "INSERT INTO shared_chats (session_id, created_by) VALUES ($1, $2) RETURNING id, session_id, token, created_by, is_active, created_at",
      [sessionId, userId]
    );
    return result.rows[0];
  },
};

module.exports = shareChatModel;
