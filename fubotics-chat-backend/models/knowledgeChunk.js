const db = require("../db");

const knowledgeChunkModel = {
  async replaceChunksForSource(sourceId, userId, sessionId, chunks) {
    await db.query("DELETE FROM knowledge_chunks WHERE source_id = $1", [sourceId]);
    for (const chunk of chunks) {
      await db.query(
        `INSERT INTO knowledge_chunks (source_id, user_id, session_id, chunk_index, content, token_count, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          sourceId,
          userId,
          sessionId,
          chunk.chunk_index,
          chunk.content,
          chunk.token_count,
          JSON.stringify(chunk.metadata || {}),
        ]
      );
    }
  },

  async searchRelevantChunks(userId, sessionId, queryText, limit = 6) {
    const normalizedQuery = String(queryText || "").trim();
    if (!normalizedQuery) return [];
    const result = await db.query(
      `SELECT
         kc.id,
         kc.source_id,
         kc.session_id,
         kc.chunk_index,
         kc.content,
         kc.token_count,
         kc.metadata,
         ks.title,
         ks.source_type,
         ks.source_url,
         ts_rank_cd(
           to_tsvector('simple', concat_ws(' ', coalesce(ks.title, ''), coalesce(ks.source_url, ''), kc.content)),
           websearch_to_tsquery('simple', $3)
         ) AS score
       FROM knowledge_chunks kc
       JOIN knowledge_sources ks ON ks.id = kc.source_id
       WHERE kc.user_id = $1
         AND ks.status = 'ready'
         AND ($2::int IS NULL OR kc.session_id = $2 OR kc.session_id IS NULL)
         AND to_tsvector('simple', concat_ws(' ', coalesce(ks.title, ''), coalesce(ks.source_url, ''), kc.content))
             @@ websearch_to_tsquery('simple', $3)
       ORDER BY
         CASE WHEN kc.session_id = $2 THEN 0 ELSE 1 END ASC,
         score DESC,
         kc.created_at DESC
       LIMIT $4`,
      [userId, Number.isInteger(sessionId) ? sessionId : null, normalizedQuery, limit]
    );
    return result.rows;
  },
};

module.exports = knowledgeChunkModel;
