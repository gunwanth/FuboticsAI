const knowledgeSourceModel = require("../models/knowledgeSource");
const knowledgeChunkModel = require("../models/knowledgeChunk");
const knowledgeJobModel = require("../models/knowledgeJob");

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
  const chunkSize = Math.max(800, options.chunkSize || 1800);
  const overlap = Math.max(120, options.overlap || 240);
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
      if (lastBoundary > cursor + 400) {
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
      const chunks = chunkText(extractedText, { chunkSize: 1600, overlap: 220 }).map((chunk) => ({
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

async function buildRagContext(userId, sessionId, queryText, limit = 6) {
  const chunks = await knowledgeChunkModel.searchRelevantChunks(userId, sessionId, queryText, limit);
  if (!chunks.length) {
    return { context: "", citations: [] };
  }

  const citations = chunks.map((chunk, idx) => ({
    ref: idx + 1,
    title: chunk.title,
    sourceType: chunk.source_type,
    sourceUrl: chunk.source_url || null,
    chunkIndex: chunk.chunk_index,
  }));

  const context = chunks
    .map((chunk, idx) => {
      const urlLine = chunk.source_url ? `\nSource URL: ${chunk.source_url}` : "";
      const label = `[RAG ${idx + 1}] ${chunk.title} (${chunk.source_type}, chunk ${chunk.chunk_index + 1})${urlLine}`;
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
