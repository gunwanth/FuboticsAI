# Semantic State Network

An adaptive semantic cognitive-state layer on top of the existing RAG / agent
architecture. It maintains a bounded semantic state graph across web
interactions, agent execution states, and metadata — with per-agent
meta-bridges, semantic vector traversal, cross-agent connectivity, and a
self-improving feedback loop.

## Design intent

This is **not** a conventional knowledge graph. The hard constraint is:

> No full-graph traversal. No loading every concept into agent context.

Every operation is bounded:

- Candidate pool is capped **before** cosine scoring (`STATE_CANDIDATE_CAP`).
- Neighborhood expansion is a BFS capped by node count (`STATE_NEIGHBORHOOD_LIMIT`),
  hop depth (`STATE_EDGE_MAX_HOPS`), and a char budget on generated context
  (`STATE_NEIGHBORHOOD_CHARS`).
- Edges are only created above a weight threshold — no all-pairs linking.
- Re-observation updates temporal state (`last_seen_at`) instead of
  duplicating nodes.
- Vector similarity is a **navigation signal, not the sole source of truth**:
  FTS pre-filtering and learned `quality` statistics always participate in the
  final rank.
- The whole layer can be disabled instantly with `SEMANTIC_STATE_ENABLED=false`.

## Compatibility

Built on the existing stack — Node.js/Express, PostgreSQL, and the NVIDIA
embedding API already used by `embeddingService.js`. Embeddings are stored as
`DOUBLE PRECISION[]` and ranked in JS via cosine similarity (the same pattern
`ragService.js` already uses). **No pgvector, no new infrastructure.**

## Data model

Appended to `database/schema.sql` (idempotent, runs at boot):

| Table | Purpose |
|---|---|
| `state_nodes` | Unified nodes: `concept`, `entity`, `web_page`, `observation`, `insight`, `agent_state`, `query`. Dedupe via `UNIQUE(user_id, node_key)`; temporal state via `first_seen_at`/`last_seen_at`; learned stats via `quality`, `usage_count`, `success_count`. |
| `state_edges` | Directed typed edges: `related_to`, `links_to`, `bridges_agent`, `derived_from`, `observed_in`, `informs`. Weighted, evidence-carrying, `UNIQUE(user_id, source_node_id, target_node_id, relation)`. |
| `agent_state` | Per-agent mutable meta-state: capabilities, current context, reasoning space, the meta-bridge text and its embedding, turn count. `UNIQUE(user_id, session_id, agent_id)`. |
| `state_traversals` | Execution history for self-improvement: nodes/edges visited, retrieved nodes, decision, outcome (`success`/`partial`/`failure`), evidence used, latency. |

## Components

### `config/semanticState.js`
Env-driven knobs (see table below). Everything defaults to safe bounded values.

### `services/semanticVectorService.js`
- `cosineSimilarity(a, b)` — JS cosine (matches `ragService.js`).
- `embedTexts(texts, inputType)` — batched embedding calls (`STATE_EMBED_BATCH`).
- `findSimilarNodes(userId, queryEmbedding, { sessionId, kinds, limit, minScore, ftsFilter })`
  — **bounded** candidate fetch (user-scoped, optional session/kinds/FTS
  pre-filter, hard candidate cap), JS cosine score, quality-adjusted rank:
  `score = similarity * (0.6 + 0.8 * quality)`.

### `services/semanticStateGraphService.js` — the core
- `recordWebObservation(userId, sessionId, { query, sources })` — **web state
  connectivity**: upserts a `query` node, fetches page *structure* (title,
  headings, key points, links via cheerio) for the top-N sources, upserts
  `web_page` nodes, and creates `observed_in` (query→page), `links_to`
  (page→page via shared links), and `related_to` (page→concept) edges.
- `buildMetaBridge(userId, sessionId, agentId, { task, sessionHistory, ... })` —
  the dynamically generated metadata block: agent, task, capabilities, active
  reasoning space, recent observations, bridged agents. Persisted to
  `agent_state` + anchored as an `agent_state` node in the graph.
- `observeAndSyncAgentState(...)` — **constant meta conversion**: re-derives
  the meta block each turn, re-embeds it, cosine-compares against the graph,
  and refreshes `related_to` edges to the nearest nodes.
- `findSemanticNeighborhood(userId, sessionId, { query, agentId, limitNodes, maxHops })`
  — the **bounded traversal**: vector-similar seeds (FTS fallback), BFS over
  edges up to `maxHops` with weight threshold + node cap, hop decay `0.6^depth`,
  char-capped context block.
- `recordInsight(...)` + `establishCrossAgentBridge(...)` — **agent-to-agent
  connectivity**: insight nodes link to the agent's state (`derived_from`) and
  to concepts; other agents whose `meta_embedding` is semantically adjacent get
  a `bridges_agent` edge — so they share context instead of rediscovering it.
- `recordTraversal(...)`, `applyFeedback(...)`, `runCognitiveFeedbackLoop(...)`
  — **self-improving state**: usage/success counts, recomputed `quality`,
  edge traversal stats, temporal decay of stale nodes. Statistics only — no
  model retraining.

## Wiring

- **`index.js`** — every deep-search path now fires `recordWebObservation`
  (fire-and-forget); `runDinoAgentLoop` + the non-agent Dino path inject the
  meta-bridge + neighborhood into the system message; `storeLearnedKnowledgeEntry`
  fires `recordInsight` (covers Dino, coding agent, and chat-turn learning);
  agent loops fire `runCognitiveFeedbackLoop` after the final reply; the new
  `inspect_state` tool is added to `DINO_AGENT_TOOLS` + `executeDinoToolLocally`.
- **`mcp-server/toolRuntime.js`** — new `inspect_state` MCP tool; `searchWeb`
  records web observations; `storeKnowledge` records insights.
- **`services/codingAgentService.js`** — meta-bridge + neighborhood injected
  into the coding agent system prompt; feedback loop after the final answer;
  `store_code_knowledge` records insights.

## The `inspect_state` tool

Returns the agent's meta-bridge, the active semantic neighborhood (nodes +
edges + context), and bridged-agent context. Lets an agent explicitly read its
own cognitive state to decide what to traverse next.

## Feedback loop

After each agent turn: the neighborhood nodes/edges are recorded in
`state_traversals` with an outcome heuristic (answer substance + citations →
`success`/`partial`/`failure`), then `applyFeedback` bumps usage/success
counts, recomputes `quality`, and decays stale nodes. Future neighborhood
retrieval blends `quality` into the rank, so successful traversals become
preferred without retraining.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `SEMANTIC_STATE_ENABLED` | `true` | Master feature flag |
| `STATE_NEIGHBORHOOD_LIMIT` | `10` | Max nodes in a neighborhood |
| `STATE_EDGE_MAX_HOPS` | `2` | Max BFS hop depth |
| `STATE_EDGE_MIN_WEIGHT` | `0.35` | Edge weight threshold for traversal |
| `STATE_META_BRIDGE_CHARS` | `800` | Meta-bridge char cap |
| `STATE_NEIGHBORHOOD_CHARS` | `4000` | Neighborhood context char cap |
| `STATE_WEB_PAGES_TO_FETCH` | `3` | Pages fetched per web observation |
| `STATE_WEB_FETCH_TIMEOUT_MS` | `10000` | Page fetch timeout |
| `STATE_DECAY_DAYS` | `30` | Temporal decay window for stale nodes |
| `STATE_EMBED_BATCH` | `20` | Embedding batch size |
| `STATE_CANDIDATE_CAP` | `60` | Candidate cap before cosine scoring |
| `STATE_RELATED_MIN_SCORE` | `0.38` | Cosine threshold for concept links |
| `STATE_BRIDGE_MIN_SCORE` | `0.4` | Cosine threshold for agent bridges |
