const db = require("../db");
const embeddingService = require("./embeddingService");
const semanticStateConfig = require("../config/semanticState");

/**
 * Semantic vector primitives for the Semantic State Network.
 * Wraps the existing NVIDIA embedding client, provides cosine similarity, and
 * runs the bounded similar-node search used by the graph service.
 *
 * Design rule: vector similarity is a NAVIGATION signal, not the sole source
 * of truth. Every search pre-filters candidates (scoped, optionally FTS) and
 * blends a learned quality score into the final rank.
 */

function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || !Array.isArray(vecA) || !Array.isArray(vecB)) return 0;
  if (vecA.length !== vecB.length || vecA.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    const a = Number(vecA[i]) || 0;
    const b = Number(vecB[i]) || 0;
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Embed texts in batches, returning a flat array of vectors aligned to input.
 * Returns [] on failure so callers can fall back gracefully (matching the
 * existing embeddingService contract).
 */
async function embedTexts(texts, inputType = "passage") {
  const input = Array.isArray(texts) ? texts : [texts];
  const clean = input.map((t) => String(t || "").trim()).filter(Boolean);
  if (clean.length === 0) return [];

  const batchSize = semanticStateConfig.embedBatch || 20;
  const vectors = [];
  for (let i = 0; i < clean.length; i += batchSize) {
    const batch = clean.slice(i, i + batchSize);
    const result = await embeddingService.getEmbeddings(batch, inputType);
    if (!result || result.length === 0) {
      return []; // fail the whole call; caller falls back to FTS/text ranking
    }
    vectors.push(...result);
  }
  return vectors;
}

/**
 * Build the FTS pre-filter clause/params for state_nodes when a text filter
 * is requested. Used to keep the candidate pool small before cosine scoring.
 */
function buildFtsFilterClause(ftsFilter) {
  if (!ftsFilter || !String(ftsFilter).trim()) return { clause: "", params: [] };
  const query = String(ftsFilter).trim();
  return {
    clause: `AND to_tsvector('simple', content)
             @@ websearch_to_tsquery('simple', $PARAM::text)`,
    params: [query],
  };
}

/**
 * Bounded similar-node search over state_nodes.
 * 1. Candidate pre-filter (user scope + optional session + optional kinds + optional FTS)
 *    with a hard candidate cap.
 * 2. JS cosine similarity against the query vector.
 * 3. Quality-adjusted score: similarity stays dominant; quality is a tiebreaker.
 *
 * @param {number} userId
 * @param {number[]|null} queryEmbedding
 * @param {object} options { sessionId, kinds, limit, minScore, ftsFilter }
 * @returns {Promise<Array>} ranked nodes with { similarity, score, ...node }
 */
async function findSimilarNodes(userId, queryEmbedding, options = {}) {
  const sessionId = Number.isInteger(options.sessionId) ? options.sessionId : null;
  const kinds = Array.isArray(options.kinds) && options.kinds.length > 0 ? options.kinds : null;
  const limit = Math.max(1, options.limit || semanticStateConfig.neighborhoodLimit || 10);
  const minScore = typeof options.minScore === "number" ? options.minScore : 0;
  const ftsFilter = options.ftsFilter || null;

  const candidateCap = Math.max(40, limit * 5);

  const kindClause = kinds ? "AND kind = ANY($PARAM::text[])" : "";
  const sessionClause = sessionId ? "AND (session_id = $PARAM OR session_id IS NULL)" : "";
  const fts = buildFtsFilterClause(ftsFilter);

  let paramIdx = 2; // $1 is always userId
  const params = [userId];
  const replaceParam = (clause) => clause.replace("$PARAM", `$${paramIdx++}`);

  const kindSql = kindClause ? replaceParam(kindClause) : "";
  if (kinds) params.push(kinds);
  const sessionSql = sessionClause ? replaceParam(sessionClause) : "";
  if (sessionId) params.push(sessionId);
  const ftsSql = fts.clause ? replaceParam(fts.clause) : "";
  if (fts.params.length) params.push(...fts.params);
  params.push(candidateCap);

  const sql = `
    SELECT id, user_id, session_id, kind, label, content, node_key,
           source_ref, source_type, provenance, salience, quality,
           usage_count, success_count, first_seen_at, last_seen_at,
           embedding
    FROM state_nodes
    WHERE user_id = $1
      ${kindSql}
      ${sessionSql}
      ${ftsSql}
    ORDER BY last_seen_at DESC
    LIMIT $${params.length}`;

  let rows = [];
  try {
    const result = await db.query(sql, params);
    rows = result.rows || [];
  } catch (err) {
    console.warn("[Semantic Vector] Candidate fetch failed:", err?.message || err, "SQL:", sql.replace(/\s+/g, " ").trim(), "params:", params.length);
    return [];
  }

  if (!queryEmbedding || queryEmbedding.length === 0) {
    // No vector available: fall back to recency-ranked candidates (FTS already
    // filtered by content when requested). Vector search is a signal, not a
    // hard requirement.
    return rows.map((row) => ({ ...row, similarity: 0, score: row.quality || 0.5 })).slice(0, limit);
  }

  const scored = rows
    .map((row) => {
      const similarity = cosineSimilarity(queryEmbedding, row.embedding);
      const quality = Number(row.quality) || 0.5;
      // Similarity dominates (0.6..1.0); quality nudges ties only.
      const score = similarity * (0.6 + 0.8 * quality);
      return { ...row, similarity, score };
    })
    .filter((row) => row.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored;
}

module.exports = {
  cosineSimilarity,
  embedTexts,
  findSimilarNodes,
};
