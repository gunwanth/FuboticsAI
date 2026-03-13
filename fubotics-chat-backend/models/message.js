const db = require("../db");

const messageModel = {
  async create(sessionId, role, content, modelUsed = null) {
    const result = await db.query(
      "INSERT INTO messages (session_id, role, content, model_used) VALUES ($1, $2, $3, $4) RETURNING id, session_id, role, content, model_used, created_at",
      [sessionId, role, content, modelUsed]
    );
    return result.rows[0];
  },

  async getBySessionId(sessionId) {
    const result = await db.query(
      `SELECT m.id, m.session_id, m.role, m.content, m.model_used, m.created_at,
              COALESCE(
                json_agg(
                  DISTINCT jsonb_build_object(
                    'id', a.id,
                    'filename', a.original_filename,
                    'file_type', a.file_type,
                    'file_path', a.file_path
                  )
                ) FILTER (WHERE a.id IS NOT NULL),
                '[]'
              ) as attachments
       FROM messages m
       LEFT JOIN message_attachments ma ON m.id = ma.message_id
       LEFT JOIN attachments a ON ma.attachment_id = a.id
       WHERE m.session_id = $1
       GROUP BY m.id
       ORDER BY m.created_at ASC`,
      [sessionId]
    );
    return result.rows;
  },

  async getById(messageId) {
    const result = await db.query(
      "SELECT id, session_id, role, content, model_used, created_at FROM messages WHERE id = $1",
      [messageId]
    );
    return result.rows[0] || null;
  },

  async updateContent(messageId, content) {
    const result = await db.query(
      "UPDATE messages SET content = $2 WHERE id = $1 RETURNING id, session_id, role, content, model_used, created_at",
      [messageId, content]
    );
    return result.rows[0] || null;
  },

  async deleteAfterMessageInSession(sessionId, messageId) {
    const result = await db.query(
      "DELETE FROM messages WHERE session_id = $1 AND id > $2 RETURNING id",
      [sessionId, messageId]
    );
    return result.rowCount;
  },

  async delete(messageId) {
    const result = await db.query(
      "DELETE FROM messages WHERE id = $1 RETURNING id",
      [messageId]
    );
    return result.rowCount > 0;
  },

  async deleteBySessionId(sessionId) {
    const result = await db.query(
      "DELETE FROM messages WHERE session_id = $1 RETURNING id",
      [sessionId]
    );
    return result.rowCount;
  },

  async getCountBySessionId(sessionId) {
    const result = await db.query(
      "SELECT COUNT(*) as count FROM messages WHERE session_id = $1",
      [sessionId]
    );
    return Number.parseInt(result.rows[0].count, 10);
  },

  async getRecentBySessionId(sessionId, limit = 10) {
    const result = await db.query(
      `SELECT m.id, m.session_id, m.role, m.content, m.model_used, m.created_at
       FROM messages m
       WHERE m.session_id = $1
       ORDER BY m.created_at DESC
       LIMIT $2`,
      [sessionId, limit]
    );
    return result.rows.reverse();
  }
};

module.exports = messageModel;
