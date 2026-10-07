const db = require("../db");
const axios = require("axios");
const cheerio = require("cheerio");
const semanticStateConfig = require("../config/semanticState");
const { cosineSimilarity, embedTexts, findSimilarNodes } = require("./semanticVectorService");

/**
 * Semantic State Network graph service.
 *
 * A dynamic cognitive-state layer: unified nodes (concepts, entities, web
 * pages, observations, insights, agent states, queries), edges between them,
 * per-agent meta-bridges, bounded semantic-neighborhood traversal, and a
 * self-improving feedback loop that records traversal outcomes and adjusts
 * node/edge quality statistics — no model retraining.
 *
 * HARD CONSTRAINT: never traverse the whole graph. Every entry point bounds
 * itself: candidate caps before cosine, node caps / hop-depth caps during
 * neighborhood expansion, char caps on generated context, and weight
 * thresholds on edge creation.
 */

const RELATIONS = new Set(["related_to", "links_to", "bridges_agent", "derived_from", "observed_in", "informs"]);

async function normalizeSession(sessionId, userId = null) {
  if (!Number.isInteger(sessionId)) return null;
  if (userId) {
    try {
      const res = await db.query("SELECT id FROM chat_sessions WHERE id = $1 AND user_id = $2", [sessionId, userId]);
      return res.rows.length > 0 ? sessionId : null;
    } catch (_) {
      return null;
    }
  }
  return sessionId;
}

function normalizeAgentId(agentId) {
  return String(agentId || "unknown").slice(0, 100);
}

function truncate(value, max) {
  return String(value || "").slice(0, max);
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

/* ------------------------------------------------------------------ *
 * Node + edge primitives (idempotent upserts, temporal touch)          *
 * ------------------------------------------------------------------ */

/**
 * Upsert a state node keyed by (user_id, node_key). Re-observation updates
 * temporal state (last_seen_at) instead of duplicating rows. Returns the node.
 */
async function upsertNode({ userId, sessionId, kind, label, content = "", nodeKey, embedding = null, sourceRef = null, sourceType = null, provenance = {} }) {
  const existing = await db.query(
    `SELECT id, embedding FROM state_nodes WHERE user_id = $1 AND node_key = $2`,
    [userId, nodeKey]
  );
  let id = null;
  let storedEmbedding = embedding;

  if (existing.rows.length > 0) {
    id = existing.rows[0].id;
    storedEmbedding = storedEmbedding || existing.rows[0].embedding;
    const cleanSessionId = Number.isInteger(sessionId) ? sessionId : null;
    await db.query(
      `UPDATE state_nodes
       SET label = $1, content = $2, session_id = COALESCE($3, session_id),
           source_ref = COALESCE($4, source_ref), source_type = COALESCE($5, source_type),
           provenance = provenance || $6, embedding = COALESCE($7, embedding),
           salience = LEAST(1.0, salience + 0.05),
           last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $8`,
      [label, truncate(content, 20000), cleanSessionId, sourceRef, sourceType, JSON.stringify(provenance || {}), storedEmbedding, id]
    );
  } else {
    const cleanSessionId = Number.isInteger(sessionId) ? sessionId : null;
    const result = await db.query(
      `INSERT INTO state_nodes
         (user_id, session_id, kind, label, content, node_key, embedding, source_ref, source_type, provenance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id, node_key) DO UPDATE SET
         last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [userId, cleanSessionId, kind, label, truncate(content, 20000), nodeKey, storedEmbedding, sourceRef, sourceType, JSON.stringify(provenance || {})]
    );
    id = result.rows[0].id;
  }

  // Fetch fresh row (embedding may have been backfilled).
  const fresh = await db.query(`SELECT * FROM state_nodes WHERE id = $1`, [id]);
  return fresh.rows[0];
}

/**
 * Upsert a directed edge keyed by (user_id, source_node_id, target_node_id, relation).
 * Higher weights win; temporal state is touched on each observation.
 */
async function upsertEdge({ userId, sourceNodeId, targetNodeId, relation, weight = 0.5, evidence = {} }) {
  if (!RELATIONS.has(relation)) return null;
  const result = await db.query(
    `INSERT INTO state_edges
       (user_id, source_node_id, target_node_id, relation, weight, evidence)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, source_node_id, target_node_id, relation) DO UPDATE SET
       weight = GREATEST(state_edges.weight, EXCLUDED.weight),
       evidence = state_edges.evidence || EXCLUDED.evidence,
       last_seen_at = CURRENT_TIMESTAMP
     RETURNING id`,
    [userId, sourceNodeId, targetNodeId, relation, Math.max(0, Math.min(1, weight)), JSON.stringify(evidence || {})]
  );
  return result.rows[0].id;
}

async function getEdgesForNode(userId, nodeId, relation = null) {
  const relationClause = relation ? "AND relation = $3" : "";
  const params = relation ? [userId, nodeId, relation] : [userId, nodeId];
  const result = await db.query(
    `SELECT id, source_node_id, target_node_id, relation, weight, traversal_count, success_count, evidence
     FROM state_edges
     WHERE user_id = $1 AND (source_node_id = $2 OR target_node_id = $2)
     ${relationClause}`,
    params
  );
  return result.rows || [];
}

async function getNodesByIds(userId, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const result = await db.query(
    `SELECT id, user_id, session_id, kind, label, content, node_key, source_ref, source_type,
            provenance, salience, quality, usage_count, success_count, first_seen_at, last_seen_at
     FROM state_nodes WHERE user_id = $1 AND id = ANY($2)`,
    [userId, ids]
  );
  return result.rows || [];
}

/* ------------------------------------------------------------------ *
 * Web state connectivity                                               *
 * ------------------------------------------------------------------ */

/**
 * Fetch a page's rendered-structure state (title, description, headings,
 * key points, same-host links). Mirrors mcp-server/toolRuntime.fetchPageSnippet.
 * Returns null on failure — page observation is best-effort.
 */
async function fetchPageState(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: semanticStateConfig.webFetchTimeoutMs,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      maxRedirects: 5,
      validateStatus: () => true,
    });
    if (!data || typeof data !== "string") return null;
    const $ = cheerio.load(data);
    $("script, style, noscript").remove();

    const title =
      $("meta[property='og:title']").attr("content") ||
      $("title").first().text().trim();
    const description =
      $("meta[property='og:description']").attr("content") ||
      $("meta[name='description']").attr("content") ||
      "";
    const headings = $("h1, h2, h3")
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean)
      .slice(0, 10);
    const keyPoints = $("li")
      .map((_, el) => $(el).text().trim())
      .get()
      .filter((t) => t.length > 3 && t.length < 200)
      .slice(0, 12);
    const relatedLinks = $("a[href]")
      .map((_, el) => {
        const href = $(el).attr("href") || "";
        try {
          const parsed = new URL(href, url);
          if (parsed.hostname === new URL(url).hostname) return parsed.toString();
        } catch (_) {}
        return null;
      })
      .get()
      .filter(Boolean)
      .slice(0, 8);
    const paragraphs = $("p")
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean)
      .slice(0, 10);

    return { title, description, headings, keyPoints, relatedLinks, paragraphs };
  } catch (err) {
    console.warn("[Semantic State] Page fetch failed:", url, err?.message || err);
    return null;
  }
}

function compactPageText(pageState, max = 1600) {
  if (!pageState) return "";
  const parts = [
    pageState.title,
    pageState.description,
    ...(pageState.headings || []),
    ...(pageState.keyPoints || []),
    ...(pageState.paragraphs || []),
  ]
    .filter(Boolean)
    .map((p) => String(p).replace(/\s+/g, " ").trim());
  return parts.join("\n").slice(0, max);
}

/**
 * Extract coarse concepts without an LLM: supplied tags, query terms, and
 * high-frequency content terms. Used to create concept nodes and link them to
 * observations — semantic relevance without hallucinated relationships.
 */
function extractConcepts(text, tags = []) {
  const concepts = new Set();
  for (const tag of Array.isArray(tags) ? tags : []) {
    const clean = String(tag || "").trim();
    if (clean) concepts.add(clean.slice(0, 120));
  }

  const body = String(text || "").toLowerCase();
  const tokens = body.match(/[a-z][a-z0-9-]{2,}/g) || [];
  const stopwords = new Set([
    "the", "and", "for", "with", "this", "that", "from", "have", "has", "are", "was", "were",
    "you", "your", "our", "they", "them", "their", "will", "would", "could", "should", "can",
    "not", "but", "all", "any", "its", "it's", "about", "into", "over", "than", "then", "there",
    "these", "those", "what", "when", "where", "which", "who", "whom", "how", "why", "also",
    "been", "being", "more", "most", "some", "such", "only", "other", "others", "each",
  ]);
  const freq = new Map();
  for (const token of tokens) {
    if (stopwords.has(token) || token.length < 4) continue;
    freq.set(token, (freq.get(token) || 0) + 1);
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  for (const [token] of top) {
    if (token.length > 3 && concepts.size < 12) concepts.add(token);
  }
  return [...concepts];
}

/**
 * Auto-link a node to existing concept/entity nodes when cosine similarity is
 * above the related threshold. Bounded: only scans a small recent candidate
 * set (user-scoped, recency-capped), never the whole graph.
 */
async function autoLinkConcepts(userId, sessionId, node) {
  if (!node?.embedding || node.embedding.length === 0) return [];

  const candidates = await findSimilarNodes(userId, node.embedding, {
    sessionId,
    kinds: ["concept", "entity"],
    limit: 12,
    minScore: semanticStateConfig.relatedMinScore,
  });

  const linked = [];
  for (const candidate of candidates) {
    if (candidate.id === node.id) continue;
    const edgeId = await upsertEdge({
      userId,
      sourceNodeId: node.id,
      targetNodeId: candidate.id,
      relation: "related_to",
      weight: candidate.similarity,
      evidence: { via: "cosine_auto_link", score: candidate.similarity },
    });
    if (edgeId) linked.push(candidate.id);
  }
  return linked;
}

/**
 * Record a web observation: query node + web_page nodes + structural edges.
 * This is the state-connectivity layer for web interactions — fetches are no
 * longer isolated; each observation mutates the persistent cognitive state.
 */
async function recordWebObservation(userId, sessionId, { query, sources = [] }) {
  if (!semanticStateConfig.enabled) return { recorded: false, reason: "disabled" };
  const qText = String(query || "").trim();
  if (!qText) return { recorded: false, reason: "no_query" };
  const session = normalizeSession(sessionId);
  const list = Array.isArray(sources) ? sources : [];
  if (list.length === 0) return { recorded: false, reason: "no_sources" };

  const started = Date.now();
  const queryEmbeddings = await embedTexts([qText], "query");
  const queryEmbedding = queryEmbeddings[0] || null;

  const queryNode = await upsertNode({
    userId,
    sessionId: session,
    kind: "query",
    label: qText.slice(0, 200),
    content: qText,
    nodeKey: `query::${session || "global"}::${slugify(qText)}`,
    embedding: queryEmbedding,
    sourceType: "user_query",
    provenance: { source: "web_observation" },
  });

  // Fetch page structure for the top-N sources (bounded concurrency).
  const pagesToFetch = list.slice(0, semanticStateConfig.webPagesToFetch);
  const pageStates = await Promise.allSettled(
    pagesToFetch.map(async (source) => {
      const url = String(source?.url || "").trim();
      if (!url) return { source, state: null };
      const state = await fetchPageState(url);
      return { source, state };
    })
  );

  const pageNodeIds = [];
  for (const settled of pageStates) {
    const { source, state } = settled.status === "fulfilled" ? settled.value : { source: null, state: null };
    if (!source) continue;
    const url = String(source?.url || "").trim();
    const title = String(state?.title || source?.title || "Untitled").trim();
    const content = compactPageText(state) || String(source?.snippet || "").slice(0, 1600);

    const pageEmbeddings = await embedTexts([content], "passage");
    const pageEmbedding = pageEmbeddings[0] || null;

    const pageNode = await upsertNode({
      userId,
      sessionId: session,
      kind: "web_page",
      label: title.slice(0, 200),
      content,
      nodeKey: `web::${url}`,
      embedding: pageEmbedding,
      sourceRef: url,
      sourceType: "web",
      provenance: {
        source: "web_observation",
        title,
        snippet: String(source?.snippet || "").slice(0, 500),
        structure: state
          ? { headings: state.headings, keyPoints: state.keyPoints.slice(0, 6), relatedLinks: state.relatedLinks }
          : null,
      },
    });
    pageNodeIds.push(pageNode.id);

    await upsertEdge({
      userId,
      sourceNodeId: queryNode.id,
      targetNodeId: pageNode.id,
      relation: "observed_in",
      weight: 0.9,
      evidence: { query: qText.slice(0, 300), url, observedAt: new Date().toISOString() },
    });

    // Link pages that share related links (structural connectivity).
    if (state?.relatedLinks?.length) {
      for (const otherUrl of state.relatedLinks.slice(0, 4)) {
        const other = await db.query(
          `SELECT id FROM state_nodes WHERE user_id = $1 AND kind = 'web_page' AND source_ref = $2`,
          [userId, otherUrl]
        );
        if (other.rows.length > 0 && other.rows[0].id !== pageNode.id) {
          await upsertEdge({
            userId,
            sourceNodeId: pageNode.id,
            targetNodeId: other.rows[0].id,
            relation: "links_to",
            weight: 0.7,
            evidence: { via: "page_link", url: otherUrl },
          });
        }
      }
    }

    await autoLinkConcepts(userId, session, pageNode);
  }

  // Concept nodes from the query itself.
  const concepts = extractConcepts(qText);
  for (const concept of concepts) {
    const conceptEmbeddings = await embedTexts([concept], "passage");
    const conceptNode = await upsertNode({
      userId,
      sessionId: session,
      kind: "concept",
      label: concept,
      content: concept,
      nodeKey: `concept::${slugify(concept)}`,
      embedding: conceptEmbeddings[0] || null,
      sourceType: "extracted",
      provenance: { source: "web_observation", from: "query" },
    });
    await upsertEdge({
      userId,
      sourceNodeId: queryNode.id,
      targetNodeId: conceptNode.id,
      relation: "informs",
      weight: 0.6,
      evidence: { query: qText.slice(0, 300) },
    });
  }

  console.log(
    `[Semantic State] Web observation recorded: query="${qText.slice(0, 60)}", pages=${pageNodeIds.length}, concepts=${concepts.length}, ${Date.now() - started}ms`
  );
  return { recorded: true, queryNodeId: queryNode.id, pageNodeIds, conceptCount: concepts.length };
}

/* ------------------------------------------------------------------ *
 * Meta-bridge + agent state                                            *
 * ------------------------------------------------------------------ */

/**
 * Build the agent's dynamic metadata block: capabilities, current context,
 * active reasoning space (top neighborhood node labels), recent observations,
 * and bridged-agent context. This is the meta-bridge that connects an agent
 * to the specific portion of the graph relevant to its current task.
 */
async function buildMetaBridge(userId, sessionId, agentId, { task = "", sessionHistory = [], capabilityOverrides = [], reasoningSpaceOverride = [] } = {}) {
  if (!semanticStateConfig.enabled) return { metaBridge: "", metaEmbedding: null };
  const session = await normalizeSession(sessionId, userId);
  const agent = String(agentId || "dino_agent").slice(0, 100);

  // Current reasoning space: nearest graph nodes to the task.
  let reasoningLabels = Array.isArray(reasoningSpaceOverride) ? reasoningSpaceOverride : [];
  let neighborhoodNodes = [];
  if (reasoningLabels.length === 0 && task) {
    try {
      const neighborhood = await findSemanticNeighborhood(userId, session, {
        query: task,
        agentId: agent,
        limitNodes: 5,
        maxHops: 1,
      });
      reasoningLabels = neighborhood.nodes.map((n) => n.label);
      neighborhoodNodes = neighborhood.nodes;
    } catch (err) {
      console.warn("[Semantic State] Meta-bridge reasoning-space fetch failed:", err?.message || err);
    }
  }

  // Recent observations from this session (bounded).
  let recentObservations = [];
  try {
    const obs = await db.query(
      `SELECT label, kind, last_seen_at
       FROM state_nodes
       WHERE user_id = $1 AND session_id = $2 AND kind IN ('web_page', 'query', 'insight')
       ORDER BY last_seen_at DESC
       LIMIT 6`,
      [userId, session]
    );
    recentObservations = (obs.rows || []).map((r) => `${r.kind}:${r.label}`);
  } catch (err) {
    console.warn("[Semantic State] Recent observations fetch failed:", err?.message || err);
  }

  // Bridged agent context: agents whose state is semantically adjacent.
  let bridgedAgents = [];
  try {
    const bridges = await db.query(
      `SELECT a.agent_id, a.current_context, a.meta_bridge, e.weight AS bridge_score
       FROM agent_state a
       JOIN state_edges e
         ON e.user_id = a.user_id
        AND (e.target_node_id = (SELECT id FROM state_nodes sn
                                 WHERE sn.user_id = a.user_id AND sn.node_key = $3)
             OR e.source_node_id = (SELECT id FROM state_nodes sn
                                    WHERE sn.user_id = a.user_id AND sn.node_key = $3))
       WHERE a.user_id = $1 AND a.session_id = $2 AND a.agent_id <> $4
       ORDER BY e.weight DESC
       LIMIT 3`,
      [userId, session, `agent::${session}::${agent}`, agent]
    );
    bridgedAgents = (bridges.rows || []).map((b) => ({
      agentId: b.agent_id,
      context: truncate(b.current_context || b.meta_bridge || "", 200),
      score: Math.round((b.bridge_score || 0) * 100),
    }));
  } catch (err) {
    console.warn("[Semantic State] Bridged-agent fetch failed:", err?.message || err);
  }

  const capabilities = Array.isArray(capabilityOverrides) && capabilityOverrides.length > 0
    ? capabilityOverrides
    : ["search_rag", "deep_search_web", "store_knowledge", "search_codebase", "inspect_state"];

  const lastUserMsg = [...(Array.isArray(sessionHistory) ? sessionHistory : [])]
    .reverse()
    .find((m) => String(m?.role || "") === "user");
  const currentTask = task || String(lastUserMsg?.content || "").slice(0, 500) || "general assistance";

  const metaBridge = [
    `Agent: ${agent}`,
    `Task: ${currentTask.slice(0, 500)}`,
    `Capabilities: ${capabilities.join(", ")}`,
    `Reasoning space: ${(reasoningLabels.length ? reasoningLabels : ["(empty)"]).slice(0, 6).join(" | ")}`,
    `Recent observations: ${(recentObservations.length ? recentObservations : ["(none)"]).slice(0, 6).join(" | ")}`,
    bridgedAgents.length
      ? `Bridged agents: ${bridgedAgents.map((b) => `${b.agentId} (${b.score}%)`).join(", ")}`
      : "Bridged agents: none",
  ].join("\n").slice(0, semanticStateConfig.metaBridgeChars);

  const metaEmbeddings = await embedTexts([metaBridge], "passage");
  const metaEmbedding = metaEmbeddings[0] || null;

  // Persist per-agent mutable meta-state (when valid session exists).
  if (session) {
    await db.query(
      `INSERT INTO agent_state
         (user_id, session_id, agent_id, capabilities, current_context, reasoning_space, meta_bridge, meta_embedding, turn_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1)
       ON CONFLICT (user_id, session_id, agent_id) DO UPDATE SET
         capabilities = $4,
         current_context = $5,
         reasoning_space = $6,
         meta_bridge = $7,
         meta_embedding = COALESCE($8, agent_state.meta_embedding),
         turn_count = agent_state.turn_count + 1,
         last_active_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP`,
      [
        userId,
        session,
        agent,
        JSON.stringify(capabilities),
        currentTask.slice(0, 1000),
        JSON.stringify(reasoningLabels.slice(0, 20)),
        metaBridge,
        metaEmbedding,
      ]
    );
  }

  // Anchor the agent in the graph so edges can target it.
  const agentNode = await upsertNode({
    userId,
    sessionId: session,
    kind: "agent_state",
    label: `Agent: ${agent}`,
    content: metaBridge,
    nodeKey: `agent::${session}::${agent}`,
    embedding: metaEmbedding,
    sourceType: "agent",
    provenance: { agent, task: currentTask.slice(0, 500) },
  });

  // Re-attach the agent node to its current reasoning space (constant meta
  // conversion): cosine-compare the fresh meta-embedding against the graph and
  // refresh related_to edges to the nearest nodes.
  let refreshedLinks = 0;
  if (metaEmbedding && metaEmbedding.length > 0) {
    const nearby = await findSimilarNodes(userId, metaEmbedding, {
      sessionId: session,
      limit: 8,
      minScore: semanticStateConfig.bridgeMinScore,
    });
    for (const candidate of nearby) {
      if (candidate.id === agentNode.id) continue;
      const edgeId = await upsertEdge({
        userId,
        sourceNodeId: agentNode.id,
        targetNodeId: candidate.id,
        relation: "related_to",
        weight: candidate.similarity,
        evidence: { via: "meta_bridge", agent },
      });
      if (edgeId) refreshedLinks += 1;
    }
  }

  return { metaBridge, metaEmbedding, agentNodeId: agentNode.id, refreshedLinks, neighborhoodNodes };
}

/**
 * Constant meta conversion: after each observation or agent turn, re-derive
 * the agent's meta block and re-link it to the graph. Fire-and-forget from
 * call sites.
 */
async function observeAndSyncAgentState(userId, sessionId, agentId, options = {}) {
  if (!semanticStateConfig.enabled) return null;
  try {
    return await buildMetaBridge(userId, sessionId, agentId, options);
  } catch (err) {
    console.warn("[Semantic State] Agent state sync failed:", err?.message || err);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Bounded semantic neighborhood traversal                             *
 * ------------------------------------------------------------------ */

/**
 * Find the most relevant semantic neighborhood for a task. Seeded by vector
 * similarity (FTS fallback if embeddings are unavailable), then expanded via
 * BFS over state_edges up to maxHops with an edge-weight threshold and a hard
 * node cap. Never walks the whole graph.
 */
async function findSemanticNeighborhood(userId, sessionId, { query, agentId = null, limitNodes, maxHops } = {}) {
  if (!semanticStateConfig.enabled) return { nodes: [], edges: [], context: "" };
  const session = normalizeSession(sessionId);
  const qText = String(query || "").trim();
  const limit = Math.min(limitNodes || semanticStateConfig.neighborhoodLimit, 20);
  const hops = Math.min(maxHops || semanticStateConfig.edgeMaxHops, 3);

  const started = Date.now();

  // Seed: vector-similar nodes (with FTS pre-filter fallback).
  let seedNodes = [];
  const queryEmbeddings = await embedTexts([qText], "query");
  const queryEmbedding = queryEmbeddings[0] || null;
  if (queryEmbedding && queryEmbedding.length > 0) {
    seedNodes = await findSimilarNodes(userId, queryEmbedding, {
      sessionId: session,
      limit,
      minScore: 0,
    });
  }
  if (seedNodes.length === 0 && qText) {
    // FTS fallback: vector search is a signal, not a hard requirement.
    const fts = await findSimilarNodes(userId, null, {
      sessionId: session,
      limit,
      ftsFilter: qText,
    });
    seedNodes = fts;
  }
  // Always include the agent's own node so its bridged state participates.
  if (agentId) {
    const agentNode = await db.query(
      `SELECT id FROM state_nodes WHERE user_id = $1 AND node_key = $2`,
      [userId, `agent::${session}::${normalizeAgentId(agentId)}`]
    );
    if (agentNode.rows.length > 0 && !seedNodes.some((n) => n.id === agentNode.rows[0].id)) {
      const full = await getNodesByIds(userId, [agentNode.rows[0].id]);
      if (full.length > 0) seedNodes.push({ ...full[0], similarity: 0.5, score: 0.5 });
    }
  }

  if (seedNodes.length === 0) return { nodes: [], edges: [], context: "" };

  // BFS expansion over edges (bounded).
  const visited = new Set();
  const collectedEdges = new Set();
  const queue = [];
  const depthMap = new Map();

  for (const node of seedNodes) {
    visited.add(node.id);
    depthMap.set(node.id, 0);
    queue.push(node.id);
  }

  while (queue.length > 0 && visited.size < limit) {
    const nodeId = queue.shift();
    const depth = depthMap.get(nodeId) || 0;
    if (depth >= hops) continue;

    const edges = await getEdgesForNode(userId, nodeId);
    for (const edge of edges) {
      if (Number(edge.weight) < semanticStateConfig.edgeMinWeight) continue;
      const neighborId = edge.source_node_id === nodeId ? edge.target_node_id : edge.source_node_id;
      if (visited.has(neighborId)) continue;

      collectedEdges.add(edge.id);
      visited.add(neighborId);
      depthMap.set(neighborId, depth + 1);
      if (visited.size >= limit) break;
      queue.push(neighborId);
    }
  }

  const nodeIds = [...visited];
  let nodes = await getNodesByIds(userId, nodeIds);
  let edges = [];
  if (collectedEdges.size > 0) {
    const edgeResult = await db.query(
      `SELECT id, source_node_id, target_node_id, relation, weight, evidence
       FROM state_edges WHERE user_id = $1 AND id = ANY($2)`,
      [userId, [...collectedEdges]]
    );
    edges = edgeResult.rows || [];
  }

  // Hop-decay salience for ordering: seeds first, then hop depth.
  const depthWeight = (id) => {
    const d = depthMap.get(id) ?? 0;
    return Math.pow(0.6, d);
  };
  // Seed nodes carry their similarity score; expanded nodes inherit the
  // traversed edge weight (decayed by depth) so ordering stays meaningful.
  const scoreByNodeId = new Map();
  for (const node of seedNodes) {
    scoreByNodeId.set(node.id, Number(node.similarity) || 0);
  }
  nodes.sort((a, b) => {
    const sa = (scoreByNodeId.get(a.id) ?? 0) * depthWeight(a.id);
    const sb = (scoreByNodeId.get(b.id) ?? 0) * depthWeight(b.id);
    return sb - sa;
  });

  // Char-capped context block.
  const contextParts = [];
  for (const node of nodes.slice(0, limit)) {
    const content = String(node.content || "").replace(/\s+/g, " ").trim();
    contextParts.push(`[${node.kind}] ${node.label}${content ? ` — ${content.slice(0, 300)}` : ""}`);
  }
  const context = contextParts.join("\n").slice(0, semanticStateConfig.neighborhoodChars);

  console.log(
    `[Semantic State] Neighborhood: seeds=${seedNodes.length}, nodes=${nodes.length}, edges=${edges.length}, hops=${hops}, ${Date.now() - started}ms`
  );
  return { nodes, edges, context, queryEmbedding };
}

/* ------------------------------------------------------------------ *
 * Insights + cross-agent bridges                                       *
 * ------------------------------------------------------------------ */

/**
 * Record a durable insight as a graph node and bridge it to other agents whose
 * meta-state is semantically adjacent — so agents share context instead of
 * independently rediscovering it.
 */
async function recordInsight(userId, sessionId, { sourceId, agentId = "dino_agent", tags = [], content = "", title = "" }) {
  if (!semanticStateConfig.enabled) return null;
  if (!sourceId) return null;
  const session = normalizeSession(sessionId);
  const agent = normalizeAgentId(agentId);
  const insightText = truncate(String(content || title || ""), 20000);

  const embeddings = await embedTexts([insightText], "passage");
  const embedding = embeddings[0] || null;

  const insightNode = await upsertNode({
    userId,
    sessionId: session,
    kind: "insight",
    label: truncate(title || "Insight", 200),
    content: insightText,
    nodeKey: `insight::${sourceId}`,
    embedding,
    sourceRef: String(sourceId),
    sourceType: "insight",
    provenance: { agent, source_id: sourceId },
  });

  // derived_from the agent's state node.
  const agentNode = await db.query(
    `SELECT id FROM state_nodes WHERE user_id = $1 AND node_key = $2`,
    [userId, `agent::${session}::${agent}`]
  );
  if (agentNode.rows.length > 0) {
    await upsertEdge({
      userId,
      sourceNodeId: insightNode.id,
      targetNodeId: agentNode.rows[0].id,
      relation: "derived_from",
      weight: 0.85,
      evidence: { agent },
    });
  }

  // Link to concept nodes.
  const concepts = extractConcepts(insightText, tags);
  for (const concept of concepts) {
    const conceptNode = await db.query(
      `SELECT id FROM state_nodes WHERE user_id = $1 AND node_key = $2`,
      [userId, `concept::${slugify(concept)}`]
    );
    if (conceptNode.rows.length > 0) {
      await upsertEdge({
        userId,
        sourceNodeId: insightNode.id,
        targetNodeId: conceptNode.rows[0].id,
        relation: "related_to",
        weight: 0.6,
        evidence: { via: "insight_concept", concept },
      });
    } else {
      const conceptEmbeddings = await embedTexts([concept], "passage");
      const created = await upsertNode({
        userId,
        sessionId: session,
        kind: "concept",
        label: concept,
        content: concept,
        nodeKey: `concept::${slugify(concept)}`,
        embedding: conceptEmbeddings[0] || null,
        sourceType: "extracted",
        provenance: { source: "insight", agent },
      });
      await upsertEdge({
        userId,
        sourceNodeId: insightNode.id,
        targetNodeId: created.id,
        relation: "related_to",
        weight: 0.6,
        evidence: { via: "insight_concept", concept },
      });
    }
  }

  // Cross-agent bridge: find other agents whose meta-embedding is close to the
  // insight embedding and connect them.
  const bridged = await establishCrossAgentBridge(userId, session, insightNode, agent);

  console.log(`[Semantic State] Insight recorded: "${String(title).slice(0, 60)}", concepts=${concepts.length}, bridgedAgents=${bridged.length}`);
  return { insightNodeId: insightNode.id, bridgedAgents: bridged };
}

/**
 * Establish contextual bridges from a new node (insight/observation) to other
 * agents' meta-state. Bounded: only other agent_state rows in this session,
 * cosine-gated.
 */
async function establishCrossAgentBridge(userId, session, fromNode, fromAgent) {
  if (!fromNode?.embedding || fromNode.embedding.length === 0) return [];
  const parsedSession = normalizeSession(session);

  const otherAgents = await db.query(
    `SELECT a.agent_id, a.meta_embedding
     FROM agent_state a
     WHERE a.user_id = $1 AND a.session_id = $2 AND a.agent_id <> $3
       AND a.meta_embedding IS NOT NULL
     LIMIT 8`,
    [userId, parsedSession, fromAgent]
  );

  const bridged = [];
  for (const agent of otherAgents.rows || []) {
    const score = cosineSimilarity(fromNode.embedding, agent.meta_embedding);
    if (score >= semanticStateConfig.bridgeMinScore) {
      const targetAgentNode = await db.query(
        `SELECT id FROM state_nodes WHERE user_id = $1 AND node_key = $2`,
        [userId, `agent::${parsedSession}::${agent.agent_id}`]
      );
      if (targetAgentNode.rows.length > 0) {
        await upsertEdge({
          userId,
          sourceNodeId: fromNode.id,
          targetNodeId: targetAgentNode.rows[0].id,
          relation: "bridges_agent",
          weight: score,
          evidence: { fromAgent, toAgent: agent.agent_id, via: "meta_similarity" },
        });
        bridged.push({ agentId: agent.agent_id, score });
      }
    }
  }
  return bridged;
}

/* ------------------------------------------------------------------ *
 * Self-improvement: traversals + feedback                              *
 * ------------------------------------------------------------------ */

async function recordTraversal(userId, sessionId, { agentId = null, query = "", goal = "", nodesVisited = [], edgesTraversed = [], retrievedNodes = [], decision = "", outcome = "partial", evidenceUsed = false, latencyMs = 0 }) {
  if (!semanticStateConfig.enabled) return null;
  try {
    const result = await db.query(
      `INSERT INTO state_traversals
         (user_id, session_id, agent_id, query, goal, nodes_visited, edges_traversed, retrieved_nodes, decision, outcome, evidence_used, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        userId,
        normalizeSession(sessionId),
        agentId ? normalizeAgentId(agentId) : null,
        truncate(query, 1000),
        truncate(goal, 1000),
        nodesVisited || [],
        edgesTraversed || [],
        retrievedNodes || [],
        truncate(decision, 1000),
        outcome,
        Boolean(evidenceUsed),
        latencyMs,
      ]
    );
    return result.rows[0].id;
  } catch (err) {
    console.warn("[Semantic State] Traversal record failed:", err?.message || err);
    return null;
  }
}

/**
 * Apply feedback to nodes and edges after a completed agent turn: bump usage,
 * adjust success counts, recompute learned quality, and decay stale nodes.
 * This is the self-improvement mechanism — statistics, not model retraining.
 */
async function applyFeedback({ nodeIds = [], edgeIds = [], outcome = "partial", cited = false }) {
  if (!semanticStateConfig.enabled) return;
  const successWeight = outcome === "success" ? 1 : outcome === "partial" ? 0.5 : 0;

  if (Array.isArray(nodeIds) && nodeIds.length > 0) {
    for (const id of nodeIds) {
      await db.query(
        `UPDATE state_nodes
         SET usage_count = usage_count + 1,
             success_count = success_count + $2,
             quality = LEAST(1.0, 0.5 * quality + 0.5 * (success_count + $2)::float / GREATEST(1, usage_count + 1))
         WHERE id = $1`,
        [id, successWeight]
      );
    }
  }

  if (Array.isArray(edgeIds) && edgeIds.length > 0) {
    for (const id of edgeIds) {
      await db.query(
        `UPDATE state_edges
         SET traversal_count = traversal_count + 1,
             success_count = success_count + $2,
             last_seen_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id, successWeight]
      );
    }
  }

  // Temporal decay: lower salience for nodes not seen within the decay window.
  await db.query(
    `UPDATE state_nodes
     SET salience = GREATEST(0.1, salience * 0.5)
     WHERE last_seen_at < CURRENT_TIMESTAMP - ($1::int || ' days')::interval
       AND salience > 0.15`,
    [semanticStateConfig.decayDays]
  );
}

/**
 * Orchestrates the full self-improvement cycle for one agent turn. Fire and
 * forget from call sites — never blocks the chat reply.
 */
async function runCognitiveFeedbackLoop(userId, sessionId, { agentId = null, query = "", goal = "", neighborhood = null, replyText = "", citationCount = 0, latencyMs = 0 }) {
  if (!semanticStateConfig.enabled) return null;
  try {
    const nodeIds = neighborhood?.nodes?.map((n) => n.id) || [];
    const edgeIds = neighborhood?.edges?.map((e) => e.id) || [];
    const retrievedIds = neighborhood?.nodes?.map((n) => n.id) || [];

    const hasSubstance = String(replyText || "").trim().length > 40;
    const evidenceUsed = citationCount > 0 || nodeIds.length > 0;
    const outcome = hasSubstance ? (evidenceUsed ? "success" : "partial") : "failure";

    const traversalId = await recordTraversal(userId, sessionId, {
      agentId,
      query,
      goal,
      nodesVisited: nodeIds,
      edgesTraversed: edgeIds,
      retrievedNodes: retrievedIds,
      decision: "bounded_neighborhood",
      outcome,
      evidenceUsed,
      latencyMs,
    });

    await applyFeedback({ nodeIds, edgeIds, outcome, cited: evidenceUsed });
    return { traversalId, outcome, nodeCount: nodeIds.length, edgeCount: edgeIds.length };
  } catch (err) {
    console.warn("[Semantic State] Cognitive feedback loop failed:", err?.message || err);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * State Keyframe Primitives (Fast-Path Latency Reduction)            *
 * ------------------------------------------------------------------ */

/**
 * Get active keyframe for user + session + agent
 */
async function getKeyframe(userId, sessionId, agentId = "dino_agent") {
  const session = await normalizeSession(sessionId, userId);
  if (!session) return null;
  const agent = normalizeAgentId(agentId);
  try {
    const res = await db.query(
      `SELECT * FROM state_keyframes 
       WHERE user_id = $1 AND session_id = $2 AND agent_id = $3`,
      [userId, session, agent]
    );
    return res.rows[0] || null;
  } catch (err) {
    console.warn("[Semantic State] getKeyframe failed:", err?.message || err);
    return null;
  }
}

/**
 * Invalidate a keyframe when context drastically changes (e.g., file uploaded)
 */
async function invalidateKeyframe(userId, sessionId, agentId = "dino_agent") {
  const session = await normalizeSession(sessionId, userId);
  if (!session) return;
  const agent = normalizeAgentId(agentId);
  try {
    await db.query(
      `UPDATE state_keyframes SET is_dirty = TRUE, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND session_id = $2 AND agent_id = $3`,
      [userId, session, agent]
    );
  } catch (_) {}
}

/**
 * Try fast-path lookup from active keyframe to bypass multi-hop BFS and remote embeddings
 */
async function tryKeyframeFastPath(userId, sessionId, agentId = "dino_agent", queryVector = null) {
  if (!semanticStateConfig.enabled) return { hit: false };
  const kf = await getKeyframe(userId, sessionId, agentId);
  if (!kf || kf.is_dirty || !kf.prebaked_prompt_block) {
    return { hit: false };
  }

  // If query vector is available and keyframe has composite embedding, check drift
  if (queryVector && Array.isArray(queryVector) && kf.composite_embedding && kf.composite_embedding.length > 0) {
    const sim = cosineSimilarity(queryVector, kf.composite_embedding);
    const drift = 1 - sim;
    const threshold = Number(kf.drift_threshold) || 0.25;
    if (drift > threshold) {
      return { hit: false, drift, reason: "drift_exceeded" };
    }
  }

  // Keyframe Hit: Update hit count asynchronously
  db.query(
    `UPDATE state_keyframes 
     SET hit_count = hit_count + 1, last_used_at = CURRENT_TIMESTAMP 
     WHERE id = $1`,
    [kf.id]
  ).catch(() => {});

  return {
    hit: true,
    prebakedBlock: kf.prebaked_prompt_block,
    activeNodeIds: kf.active_node_ids || [],
    keyframeId: kf.id,
  };
}

/**
 * Save or update a keyframe snapshot
 */
async function saveKeyframe(userId, sessionId, agentId, {
  turnAnchor = 1,
  stateHash = "",
  compositeEmbedding = [],
  driftThreshold = 0.25,
  prebakedPromptBlock = "",
  activeNodeIds = [],
  activeConcepts = [],
} = {}) {
  const session = await normalizeSession(sessionId, userId);
  if (!session) return null;
  const agent = normalizeAgentId(agentId);

  try {
    const res = await db.query(
      `INSERT INTO state_keyframes
         (user_id, session_id, agent_id, turn_anchor, state_hash, composite_embedding,
          drift_threshold, prebaked_prompt_block, active_node_ids, active_concepts, is_dirty, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, FALSE, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, session_id, agent_id) DO UPDATE SET
         turn_anchor = EXCLUDED.turn_anchor,
         state_hash = EXCLUDED.state_hash,
         composite_embedding = CASE WHEN array_length(EXCLUDED.composite_embedding, 1) > 0 THEN EXCLUDED.composite_embedding ELSE state_keyframes.composite_embedding END,
         drift_threshold = EXCLUDED.drift_threshold,
         prebaked_prompt_block = EXCLUDED.prebaked_prompt_block,
         active_node_ids = EXCLUDED.active_node_ids,
         active_concepts = EXCLUDED.active_concepts,
         is_dirty = FALSE,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [
        userId,
        session,
        agent,
        turnAnchor,
        stateHash || `h_${Date.now()}`,
        compositeEmbedding || [],
        driftThreshold,
        prebakedPromptBlock,
        activeNodeIds || [],
        JSON.stringify(activeConcepts || []),
      ]
    );
    return res.rows[0]?.id || null;
  } catch (err) {
    console.warn("[Semantic State] saveKeyframe failed:", err?.message || err);
    return null;
  }
}

module.exports = {
  upsertNode,
  upsertEdge,
  getEdgesForNode,
  getNodesByIds,
  fetchPageState,
  recordWebObservation,
  extractConcepts,
  autoLinkConcepts,
  buildMetaBridge,
  observeAndSyncAgentState,
  findSemanticNeighborhood,
  recordInsight,
  establishCrossAgentBridge,
  recordTraversal,
  applyFeedback,
  runCognitiveFeedbackLoop,
  getKeyframe,
  invalidateKeyframe,
  tryKeyframeFastPath,
  saveKeyframe,
};
