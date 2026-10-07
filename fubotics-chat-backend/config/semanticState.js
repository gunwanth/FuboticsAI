// Semantic State Network configuration.
// Env-driven knobs that control bounded traversal, meta-bridge sizing, and
// the self-improvement feedback loop. All values are safe defaults for the
// existing Postgres + JS-cosine stack; no pgvector required.

function boolFromEnv(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).toLowerCase() === "true";
}

function intFromEnv(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function floatFromEnv(value, fallback) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const config = {
  enabled: boolFromEnv(process.env.SEMANTIC_STATE_ENABLED, true),

  // Bounded neighborhood traversal
  neighborhoodLimit: intFromEnv(process.env.STATE_NEIGHBORHOOD_LIMIT, 10),
  edgeMaxHops: intFromEnv(process.env.STATE_EDGE_MAX_HOPS, 2),
  edgeMinWeight: floatFromEnv(process.env.STATE_EDGE_MIN_WEIGHT, 0.35),
  metaBridgeChars: intFromEnv(process.env.STATE_META_BRIDGE_CHARS, 800),
  neighborhoodChars: intFromEnv(process.env.STATE_NEIGHBORHOOD_CHARS, 4000),

  // Web observation
  webPagesToFetch: intFromEnv(process.env.STATE_WEB_PAGES_TO_FETCH, 3),
  webFetchTimeoutMs: intFromEnv(process.env.STATE_WEB_FETCH_TIMEOUT_MS, 10000),

  // Self-improvement / temporal state
  decayDays: intFromEnv(process.env.STATE_DECAY_DAYS, 30),
  embedBatch: intFromEnv(process.env.STATE_EMBED_BATCH, 20),

  // Vector search candidate cap (pre-filter before cosine)
  candidateCap: intFromEnv(process.env.STATE_CANDIDATE_CAP, 60),

  // Similarity thresholds
  relatedMinScore: floatFromEnv(process.env.STATE_RELATED_MIN_SCORE, 0.38),
  bridgeMinScore: floatFromEnv(process.env.STATE_BRIDGE_MIN_SCORE, 0.4),
};

module.exports = config;
