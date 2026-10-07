const db = require("../db");
const userProfileModel = require("../models/userProfile");
const semanticStateConfig = require("../config/semanticState");
const { embedTexts, findSimilarNodes } = require("./semanticVectorService");
const semanticStateGraph = require("./semanticStateGraphService");

/**
 * Persistent User & Context Management Service
 * 
 * Implements:
 * 1. User Profile & Persona Management (Bio, Custom Instructions, Preferences)
 * 2. Dynamic Semantic Memory Retrieval from State Network
 * 3. Tri-Stream Context Synthesis (Working Chat + Persistent Memory + External Sources)
 * 4. Asynchronous Background Memory Extraction from user interactions
 */

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const MEMORY_PATTERNS = [
  /(?:my\s+(?:goal|target|plan|dream|aim)\s+is|i\s+(?:want|plan|aim|intend)\s+to)\s+([^.!?\n]+)/i,
  /(?:i\s+(?:am|work\s+as|study)\s+(?:a|an)?)\s+([^.!?\n]+)/i,
  /(?:i\s+(?:prefer|like|always\s+use|dislike|hate))\s+([^.!?\n]+)/i,
  /(?:my\s+(?:tech\s+stack|stack|programming\s+language|project)\s+is)\s+([^.!?\n]+)/i,
  /(?:i\s+(?:live\s+in|am\s+from|located\s+in))\s+([^.!?\n]+)/i,
  /(?:remember\s+that|note\s+that|keep\s+in\s+mind\s+that)\s+([^.!?\n]+)/i,
];

class UserContextService {
  /**
   * Retrieves persistent user context and relevant memory nodes for a query
   * @param {number} userId 
   * @param {string} queryText 
   * @param {Object} options 
   * @returns {Promise<{ profile: Object|null, memories: Array, promptBlock: string }>}
   */
  async getUserContext(userId, queryText = "", options = {}) {
    if (!userId) {
      return { profile: null, memories: [], promptBlock: "" };
    }

    const limit = options.limit || 3;
    const maxChars = options.maxChars || 800;

    // 1. Fetch user profile
    let profile = null;
    try {
      profile = await userProfileModel.getByUserId(userId);
    } catch (err) {
      console.warn("[User Context] Failed to fetch profile:", err?.message || err);
    }

    // 2. Fetch relevant memory nodes from Semantic State Network
    let memories = [];
    try {
      if (queryText && queryText.trim()) {
        const queryEmbeddings = await embedTexts([queryText], "query");
        if (queryEmbeddings.length > 0) {
          const similar = await findSimilarNodes(userId, queryEmbeddings[0], {
            kinds: ["user_memory", "user_preference", "insight"],
            limit,
            minScore: 0.35,
          });
          memories = (similar || []).map((s) => s.node);
        }
      }

      // If no vector hits, fallback to most recent user memories
      if (memories.length === 0) {
        const recentRes = await db.query(
          `SELECT id, kind, label, content, last_seen_at
           FROM state_nodes
           WHERE user_id = $1 AND kind IN ('user_memory', 'user_preference')
           ORDER BY last_seen_at DESC
           LIMIT $2`,
          [userId, limit]
        );
        memories = recentRes.rows;
      }
    } catch (err) {
      console.warn("[User Context] Failed to retrieve memory nodes:", err?.message || err);
    }

    // 3. Assemble compact prompt context block
    const promptLines = [];

    if (profile?.display_name) {
      promptLines.push(`- User: ${profile.display_name}`);
    }
    if (profile?.about_user) {
      promptLines.push(`- Profile/Background: ${profile.about_user}`);
    }
    if (profile?.global_instructions) {
      promptLines.push(`- Custom Instructions: ${profile.global_instructions}`);
    }
    if (profile?.preferences && Object.keys(profile.preferences).length > 0) {
      const prefsStr = Object.entries(profile.preferences)
        .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
        .join(", ");
      promptLines.push(`- Preferences: ${prefsStr}`);
    }

    if (memories && memories.length > 0) {
      promptLines.push("- Persistent Memories:");
      for (const mem of memories) {
        promptLines.push(`  • [${mem.label}] ${mem.content || ""}`);
      }
    }

    const rawBlock = promptLines.join("\n").trim();
    const promptBlock = rawBlock ? `[Persistent User Profile & Context]\n${rawBlock.slice(0, maxChars)}` : "";

    return { profile, memories, promptBlock };
  }

  /**
   * Synthesizes tri-stream context into a clean, bounded system prompt block
   * @param {Object} params 
   * @returns {string} Synthesized context block
   */
  synthesizeContext({
    userContextBlock = "",
    cognitiveStateBlock = "",
    ragContextBlock = "",
    maxChars = 4000,
  } = {}) {
    const blocks = [
      userContextBlock ? userContextBlock.trim() : "",
      cognitiveStateBlock ? cognitiveStateBlock.trim() : "",
      ragContextBlock ? ragContextBlock.trim() : "",
    ].filter(Boolean);

    if (blocks.length === 0) return "";

    const combined = blocks.join("\n\n");
    if (combined.length <= maxChars) {
      return combined;
    }

    // Cleanly truncate at newline boundary
    const sliced = combined.slice(0, maxChars);
    const lastNewline = sliced.lastIndexOf("\n");
    return lastNewline > maxChars / 2 ? sliced.slice(0, lastNewline) : sliced;
  }

  /**
   * Asynchronously extracts durable user facts/preferences from conversation turns
   * Runs fire-and-forget in the background
   * @param {number} userId 
   * @param {number} sessionId 
   * @param {string} userMessage 
   * @param {string} assistantReply 
   */
  async extractAndSaveUserMemory(userId, sessionId, userMessage, assistantReply = "") {
    if (!userId || !userMessage) return;

    try {
      const text = String(userMessage || "").trim();
      const extractedMemories = [];

      for (const pattern of MEMORY_PATTERNS) {
        const match = text.match(pattern);
        if (match && match[1]) {
          const rawFact = match[1].trim();
          if (rawFact.length >= 5 && rawFact.length <= 250) {
            extractedMemories.push(rawFact);
          }
        }
      }

      let validSessionId = null;
      if (sessionId && Number.isInteger(sessionId)) {
        try {
          const sessCheck = await db.query("SELECT id FROM chat_sessions WHERE id = $1 AND user_id = $2", [sessionId, userId]);
          if (sessCheck.rows.length > 0) {
            validSessionId = sessionId;
          }
        } catch (_) {}
      }

      for (const fact of extractedMemories) {
        const label = fact.slice(0, 60);
        const nodeKey = `user_mem::${userId}::${slugify(label)}`;

        // Check if node exists
        const existingRes = await db.query(
          `SELECT id FROM state_nodes WHERE user_id = $1 AND node_key = $2`,
          [userId, nodeKey]
        );

        let embedding = null;
        try {
          const vectors = await embedTexts([fact], "passage");
          embedding = vectors[0] || null;
        } catch (_) {}

        if (existingRes.rows.length > 0) {
          // Update last seen and content
          await db.query(
            `UPDATE state_nodes
             SET content = $1,
                 embedding = COALESCE($2, embedding),
                 last_seen_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP,
                 usage_count = usage_count + 1
             WHERE id = $3`,
            [fact, embedding, existingRes.rows[0].id]
          );
        } else {
          // Insert new user memory node (cross-session memory)
          await db.query(
            `INSERT INTO state_nodes (user_id, session_id, kind, label, content, node_key, embedding, salience, quality, first_seen_at, last_seen_at)
             VALUES ($1, $2, 'user_memory', $3, $4, $5, $6, 0.8, 0.8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id, node_key) DO UPDATE
             SET last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`,
            [userId, validSessionId, label, fact, nodeKey, embedding]
          );
        }
      }
    } catch (err) {
      console.warn("[User Context] Background memory extraction failed:", err?.message || err);
    }
  }

  /**
   * Get all persistent memories for a user
   * @param {number} userId 
   * @param {number} limit 
   * @param {number} offset 
   */
  async getUserMemories(userId, limit = 50, offset = 0) {
    const res = await db.query(
      `SELECT id, kind, label, content, node_key, salience, quality, usage_count, first_seen_at, last_seen_at
       FROM state_nodes
       WHERE user_id = $1 AND kind IN ('user_memory', 'user_preference')
       ORDER BY last_seen_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
    return res.rows;
  }

  /**
   * Delete a persistent memory node
   * @param {number} userId 
   * @param {number} memoryId 
   */
  async deleteUserMemory(userId, memoryId) {
    const res = await db.query(
      `DELETE FROM state_nodes
       WHERE id = $1 AND user_id = $2 AND kind IN ('user_memory', 'user_preference')
       RETURNING id`,
      [memoryId, userId]
    );
    return res.rowCount > 0;
  }
}

module.exports = new UserContextService();
