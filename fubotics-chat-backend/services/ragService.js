const knowledgeSourceModel = require("../models/knowledgeSource");
const knowledgeChunkModel = require("../models/knowledgeChunk");
const knowledgeJobModel = require("../models/knowledgeJob");
const embeddingService = require("./embeddingService");

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function extractKnowledgeTextFromAttachment(attachment) {
  const parsed = safeJsonParse(attachment?.analysis_result);
  if (parsed && typeof parsed === "object") {
    const extracted = String(parsed.extracted_text || parsed.preview || "").trim();
    if (extracted) return extracted;
  }
  return String(attachment?.analysis_result || "").trim();
}

function extractKnowledgeTextFromWebSource(source) {
  const title = String(source?.title || "").trim();
  const url = String(source?.url || "").trim();
  const snippet = String(source?.snippet || "").replace(/\s+/g, " ").trim();
  const fullText = String(source?.content || "").replace(/\s+/g, " ").trim();
  return [
    title ? `Title: ${title}` : "",
    url ? `URL: ${url}` : "",
    fullText ? `Content: ${fullText}` : "",
    snippet && !fullText ? `Snippet: ${snippet}` : "",
  ].filter(Boolean).join("\n");
}

function chunkText(content, options = {}) {
  const text = String(content || "").replace(/\r/g, "").trim();
  if (!text) return [];
  // Optimized chunk sizes for better latency - smaller chunks for faster retrieval
  const chunkSize = Math.max(500, options.chunkSize || 1200);  // Reduced from 1800 to 1200
  const overlap = Math.max(80, options.overlap || 120);       // Reduced from 240 to 120
  const chunks = [];
  let cursor = 0;
  let chunkIndex = 0;

  while (cursor < text.length) {
    let end = Math.min(text.length, cursor + chunkSize);
    if (end < text.length) {
      const lastBoundary = Math.max(
        text.lastIndexOf("\n\n", end),
        text.lastIndexOf(". ", end),
        text.lastIndexOf("\n", end)
      );
      if (lastBoundary > cursor + 200) {  // Reduced from 400 to 200 for tighter chunks
        end = lastBoundary + 1;
      }
    }
    const slice = text.slice(cursor, end).trim();
    if (slice) {
      chunks.push({
        chunk_index: chunkIndex,
        content: slice,
        token_count: slice.split(/\s+/).filter(Boolean).length,
        metadata: {
          start_offset: cursor,
          end_offset: end,
        },
      });
      chunkIndex += 1;
    }
    if (end >= text.length) break;
    cursor = Math.max(end - overlap, cursor + 1);
  }
  return chunks;
}

async function indexAttachmentForRag(userId, sessionId, attachment) {
  const extractedText = extractKnowledgeTextFromAttachment(attachment);
  if (!extractedText) {
    return { indexed: false, reason: "no_extractable_text" };
  }

  const source = await knowledgeSourceModel.upsertAttachmentSource(userId, sessionId, attachment, {
    file_type: attachment.file_type || null,
    original_filename: attachment.original_filename || attachment.filename || null,
    attachment_id: attachment.id,
  });
  const job = await knowledgeJobModel.create(source.id, "index_attachment", "running");

  try {
    const chunks = chunkText(extractedText);
    await knowledgeChunkModel.replaceChunksForSource(source.id, userId, sessionId, chunks);
    await knowledgeJobModel.updateStatus(job.id, "completed");
    return { indexed: true, chunkCount: chunks.length, sourceId: source.id };
  } catch (err) {
    await knowledgeJobModel.updateStatus(job.id, "failed", err?.message || "index failed");
    throw err;
  }
}

async function indexWebSourcesForRag(userId, sessionId, sources = []) {
  const indexed = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const extractedText = extractKnowledgeTextFromWebSource(source);
    if (!extractedText) continue;

    const knowledgeSource = await knowledgeSourceModel.upsertWebSource(userId, sessionId, source, {
      source_url: source.url || null,
      title: source.title || null,
      snippet: source.snippet || null,
    });
    const job = await knowledgeJobModel.create(knowledgeSource.id, "index_web_source", "running");

    try {
      const chunks = chunkText(extractedText, { chunkSize: 1200, overlap: 120 }).map((chunk) => ({
        ...chunk,
        metadata: {
          ...(chunk.metadata || {}),
          source_url: source.url || null,
          source_title: source.title || null,
        },
      }));
      await knowledgeChunkModel.replaceChunksForSource(knowledgeSource.id, userId, sessionId, chunks);
      await knowledgeJobModel.updateStatus(job.id, "completed");
      indexed.push({ sourceId: knowledgeSource.id, chunkCount: chunks.length, url: source.url || null });
    } catch (err) {
      await knowledgeJobModel.updateStatus(job.id, "failed", err?.message || "index failed");
      throw err;
    }
  }
  return indexed;
}

function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function buildRagContext(userId, sessionId, queryText, limit = 6, minScoreThreshold = 0.1, minConfidenceThreshold = 0.2) {
  // 1. Fetch a larger pool of candidates using traditional GIN-indexed FTS
  const ftsLimit = Math.max(50, limit * 4);
  const candidates = await knowledgeChunkModel.searchRelevantChunks(userId, sessionId, queryText, ftsLimit, 0.01);
  
  if (!candidates.length) {
    return { context: "", citations: [] };
  }

  let finalChunks = [];

  try {
    // 2. Try to generate query embedding for semantic similarity comparison
    const queryEmbeddings = await embeddingService.getEmbeddings([queryText], "query");
    const queryVector = queryEmbeddings?.[0];

    if (queryVector && queryVector.length > 0) {
      console.log(`[RAG Service] Performing semantic similarity ranking on ${candidates.length} candidates.`);
      
      const ranked = candidates.map(chunk => {
        let similarity = 0;
        if (chunk.embedding && Array.isArray(chunk.embedding)) {
          // Calculate cosine similarity
          similarity = cosineSimilarity(queryVector, chunk.embedding);
        } else {
          // Fallback: If chunk has no embedding stored, use its normalized FTS confidence
          similarity = chunk.confidence || 0.1;
        }

        return {
          ...chunk,
          semantic_score: similarity,
          confidence: similarity // Override confidence with semantic score
        };
      });

      // Sort by semantic score in descending order
      ranked.sort((a, b) => b.semantic_score - a.semantic_score);
      finalChunks = ranked;
    } else {
      // Fallback: No query vector returned (API key missing or request error)
      console.warn("[RAG Service] No query vector generated. Falling back to traditional FTS ranking.");
      finalChunks = candidates;
    }
  } catch (err) {
    console.warn("[RAG Service] Semantic search failed. Falling back to traditional FTS ranking:", err?.message || err);
    finalChunks = candidates;
  }

  // Filter chunks by confidence threshold
  let confidentChunks = finalChunks.filter(chunk => chunk.confidence >= minConfidenceThreshold);

  // If FTS fallback was used and we filtered out too much, or if no chunks met semantic threshold
  if (!confidentChunks.length && finalChunks.length > 0) {
    // Graceful fallback: return top candidates regardless of threshold, using a lower threshold
    confidentChunks = finalChunks.filter(chunk => chunk.confidence >= Math.max(0.1, minConfidenceThreshold / 2));
  }

  // Slice to final limit
  const slicedChunks = confidentChunks.slice(0, limit);

  if (!slicedChunks.length) {
    return { context: "", citations: [] };
  }

  const citations = slicedChunks.map((chunk, idx) => ({
    ref: idx + 1,
    title: chunk.title,
    sourceType: chunk.source_type,
    sourceUrl: chunk.source_url || null,
    chunkIndex: chunk.chunk_index,
    confidence: chunk.confidence
  }));

  const context = slicedChunks
    .map((chunk, idx) => {
      const urlLine = chunk.source_url ? `\nSource URL: ${chunk.source_url}` : "";
      const confidenceLabel = chunk.confidence ? ` (confidence: ${Math.round(chunk.confidence * 100)}%)` : "";
      const label = `[RAG ${idx + 1}] ${chunk.title} (${chunk.source_type}, chunk ${chunk.chunk_index + 1})${confidenceLabel}${urlLine}`;
      return `${label}\n${chunk.content}`;
    })
    .join("\n\n")
    .slice(0, 12000);

  return { context, citations };
}

module.exports = {
  buildRagContext,
  indexAttachmentForRag,
  indexWebSourcesForRag,
  chunkText,
};
