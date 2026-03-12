const db = require("../db");

const knowledgeSourceModel = {
  async upsertAttachmentSource(userId, sessionId, attachment, metadata = {}) {
    const result = await db.query(
      `INSERT INTO knowledge_sources (user_id, session_id, attachment_id, source_type, title, metadata, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'ready')
       ON CONFLICT (attachment_id)
       DO UPDATE SET
         title = EXCLUDED.title,
         metadata = EXCLUDED.metadata,
         status = 'ready',
         updated_at = CURRENT_TIMESTAMP
       RETURNING id, user_id, session_id, attachment_id, source_type, title, metadata, status, created_at, updated_at`,
      [
        userId,
        sessionId,
        attachment.id,
        "attachment",
        attachment.original_filename || attachment.filename || "attachment",
        JSON.stringify(metadata || {}),
      ]
    );
    return result.rows[0];
  },

  async upsertWebSource(userId, sessionId, source, metadata = {}) {
    const title = source.title || source.url || "web source";
    const sourceUrl = source.url || null;
    const existing = await db.query(
      `SELECT id
       FROM knowledge_sources
       WHERE user_id = $1
         AND ($2::int IS NULL OR session_id = $2)
         AND source_type = 'web'
         AND source_url = $3
       LIMIT 1`,
      [userId, Number.isInteger(sessionId) ? sessionId : null, sourceUrl]
    );

    if (existing.rows[0]?.id) {
      const updated = await db.query(
        `UPDATE knowledge_sources
         SET title = $2,
             metadata = $3,
             status = 'ready',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING id, user_id, session_id, attachment_id, source_type, title, source_url, metadata, status, created_at, updated_at`,
        [existing.rows[0].id, title, JSON.stringify(metadata || {})]
      );
      return updated.rows[0];
    }

    const inserted = await db.query(
      `INSERT INTO knowledge_sources (user_id, session_id, source_type, title, source_url, metadata, status)
       VALUES ($1, $2, 'web', $3, $4, $5, 'ready')
       RETURNING id, user_id, session_id, attachment_id, source_type, title, source_url, metadata, status, created_at, updated_at`,
      [userId, Number.isInteger(sessionId) ? sessionId : null, title, sourceUrl, JSON.stringify(metadata || {})]
    );
    return inserted.rows[0];
  },
};

module.exports = knowledgeSourceModel;
