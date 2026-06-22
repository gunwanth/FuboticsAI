const db = require("../db");
const embeddingService = require("../services/embeddingService");

const knowledgeChunkModel = {
  async replaceChunksForSource(sourceId, userId, sessionId, chunks) {
    // Generate embeddings in batch if not already present
    const chunksToEmbed = (chunks || []).filter(c => !c.embedding);
    if (chunksToEmbed.length > 0) {
      try {
        const texts = chunksToEmbed.map(c => c.content);
        const embeddings = await embeddingService.getEmbeddings(texts, "passage");
        for (let i = 0; i < chunksToEmbed.length; i++) {
          if (embeddings[i]) {
            chunksToEmbed[i].embedding = embeddings[i];
          }
        }
      } catch (err) {
        console.warn("[Database Model] Failed to generate embeddings for chunks:", err?.message || err);
      }
    }

    await db.query("DELETE FROM knowledge_chunks WHERE source_id = $1", [sourceId]);
    for (const chunk of chunks) {
      await db.query(
        `INSERT INTO knowledge_chunks (source_id, user_id, session_id, chunk_index, content, token_count, metadata, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          sourceId,
          userId,
          sessionId,
          chunk.chunk_index,
          chunk.content,
          chunk.token_count,
          JSON.stringify(chunk.metadata || {}),
          chunk.embedding || null,
        ]
      );
    }
  },

  async searchRelevantChunks(userId, sessionId, queryText, limit = 6, minScoreThreshold = 0.1) {
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
         kc.embedding,
         ts_rank_cd(
           to_tsvector('simple', concat_ws(' ', coalesce(ks.title, ''), coalesce(ks.source_url, ''), kc.content)),
           websearch_to_tsquery('simple', $3)
         ) AS score
       FROM knowledge_chunks kc
       JOIN knowledge_sources ks ON ks.id = kc.source_id
       WHERE kc.user_id = $1
         AND ks.status = 'ready'
         AND ($2::int IS NULL OR kc.session_id = $2 OR kc.session_id IS NULL)
         AND to_tsvector('simple', kc.content)
             @@ websearch_to_tsquery('simple', $3)
         AND ts_rank_cd(
           to_tsvector('simple', concat_ws(' ', coalesce(ks.title, ''), coalesce(ks.source_url, ''), kc.content)),
           websearch_to_tsquery('simple', $3)
         ) >= $5
       ORDER BY
         CASE WHEN kc.session_id = $2 THEN 0 ELSE 1 END ASC,
         score DESC,
         kc.created_at DESC
       LIMIT $4`,
      [userId, Number.isInteger(sessionId) ? sessionId : null, normalizedQuery, limit, minScoreThreshold]
    );

    // Add confidence scores to chunks (normalize score to 0-1 range)
    const maxScore = result.rows.length > 0 ? Math.max(...result.rows.map(r => r.score)) : 1;
    return result.rows.map(row => ({
      ...row,
      confidence: maxScore > 0 ? Math.min(1, row.score / maxScore) : 0
    }));
  },
};

module.exports = knowledgeChunkModel;
