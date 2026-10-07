-- PostgreSQL schema for Fubotics Chat
SET client_min_messages TO WARNING;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  email VARCHAR(255),
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(500) UNIQUE NOT NULL,
  token_type VARCHAR(20) NOT NULL DEFAULT 'refresh',
  session_id UUID NOT NULL DEFAULT uuid_generate_v4(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMPTZ,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at TIMESTAMPTZ,
  replaced_by_token_id INTEGER REFERENCES auth_tokens(id) ON DELETE SET NULL,
  rotated_from_id INTEGER REFERENCES auth_tokens(id) ON DELETE SET NULL,
  device_info VARCHAR(255),
  user_agent TEXT,
  ip_address VARCHAR(45)
);

CREATE TABLE IF NOT EXISTS session_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id VARCHAR(100) NOT NULL,
  action VARCHAR(50) NOT NULL,
  ip_address VARCHAR(45),
  user_agent TEXT,
  device_info VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_number INTEGER NOT NULL,
  name VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  model_used VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE messages
ADD COLUMN IF NOT EXISTS model_used VARCHAR(50);

CREATE TABLE IF NOT EXISTS attachments (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  filename VARCHAR(255) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  file_path TEXT NOT NULL,
  file_type VARCHAR(100),
  file_size BIGINT,
  analysis_result TEXT,
  is_generated BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS message_attachments (
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_id INTEGER NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(message_id, attachment_id)
);

CREATE TABLE IF NOT EXISTS shared_chats (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  token UUID NOT NULL DEFAULT uuid_generate_v4(),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(token),
  UNIQUE(session_id)
);

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
  attachment_id INTEGER REFERENCES attachments(id) ON DELETE CASCADE,
  source_type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  source_url TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'ready',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (attachment_id)
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id SERIAL PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding DOUBLE PRECISION[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS knowledge_jobs (
  id SERIAL PRIMARY KEY,
  source_id INTEGER REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  job_type VARCHAR(50) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'queued',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_token ON auth_tokens(token);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_id ON auth_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_session_id ON auth_tokens(session_id);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires_at ON auth_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_active
  ON auth_tokens(user_id, expires_at DESC)
  WHERE revoked = FALSE;

CREATE INDEX IF NOT EXISTS idx_session_logs_user_id ON session_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_session_logs_session_id ON session_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_session_logs_created_at ON session_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_logs_action ON session_logs(action);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id ON chat_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id_created_at ON chat_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated_at ON chat_sessions(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_session_id_created_at ON messages(session_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_attachments_session_id ON attachments(session_id);
CREATE INDEX IF NOT EXISTS idx_attachments_session_id_created_at ON attachments(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attachments_is_generated ON attachments(is_generated);

CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id ON message_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_message_attachments_attachment_id ON message_attachments(attachment_id);
CREATE INDEX IF NOT EXISTS idx_shared_chats_token ON shared_chats(token);
CREATE INDEX IF NOT EXISTS idx_shared_chats_session_id ON shared_chats(session_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_user_id ON knowledge_sources(user_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_session_id ON knowledge_sources(session_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_attachment_id ON knowledge_sources(attachment_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_status ON knowledge_sources(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_sources_web_unique
ON knowledge_sources(user_id, session_id, source_type, source_url)
WHERE source_url IS NOT NULL AND source_type = 'web';
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_source_id ON knowledge_chunks(source_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_user_id ON knowledge_chunks(user_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_session_id ON knowledge_chunks(session_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_created_at ON knowledge_chunks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_search ON knowledge_chunks
USING GIN (to_tsvector('simple', content));
CREATE INDEX IF NOT EXISTS idx_knowledge_jobs_source_id ON knowledge_jobs(source_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_jobs_status ON knowledge_jobs(status);

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE chat_sessions
ADD COLUMN IF NOT EXISTS session_number INTEGER;

WITH ordered AS (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at ASC, id ASC) AS rn
  FROM chat_sessions
)
UPDATE chat_sessions cs
SET session_number = ordered.rn
FROM ordered
WHERE cs.id = ordered.id
  AND (cs.session_number IS NULL OR cs.session_number <= 0);

ALTER TABLE chat_sessions
ALTER COLUMN session_number SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_user_session_number
ON chat_sessions(user_id, session_number);

ALTER TABLE users
ADD COLUMN IF NOT EXISTS email VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
ON users(email)
WHERE email IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'update_users_updated_at'
      AND tgrelid = 'users'::regclass
  ) THEN
    CREATE TRIGGER update_users_updated_at
      BEFORE UPDATE ON users
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'update_knowledge_sources_updated_at'
      AND tgrelid = 'knowledge_sources'::regclass
  ) THEN
    CREATE TRIGGER update_knowledge_sources_updated_at
      BEFORE UPDATE ON knowledge_sources
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'update_knowledge_jobs_updated_at'
      AND tgrelid = 'knowledge_jobs'::regclass
  ) THEN
    CREATE TRIGGER update_knowledge_jobs_updated_at
      BEFORE UPDATE ON knowledge_jobs
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'update_chat_sessions_updated_at'
      AND tgrelid = 'chat_sessions'::regclass
  ) THEN
    CREATE TRIGGER update_chat_sessions_updated_at
      BEFORE UPDATE ON chat_sessions
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

CREATE OR REPLACE VIEW user_session_summary AS
SELECT
  u.id AS user_id,
  u.username,
  COUNT(DISTINCT cs.id) AS total_sessions,
  COUNT(DISTINCT m.id) AS total_messages,
  MAX(cs.created_at) AS last_session_created,
  MAX(m.created_at) AS last_message_sent
FROM users u
LEFT JOIN chat_sessions cs ON u.id = cs.user_id
LEFT JOIN messages m ON cs.id = m.session_id
GROUP BY u.id, u.username;

-- ============================================================================
-- Semantic State Network
-- Dynamic cognitive-state layer: unified graph nodes, edges, per-agent
-- meta-bridge state, and traversal history for the self-improvement loop.
-- All traversal is bounded (node/hop/char caps); this is intentionally NOT a
-- full knowledge graph that gets walked wholesale.
-- ============================================================================

CREATE TABLE IF NOT EXISTS state_nodes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
  kind VARCHAR(30) NOT NULL,
  label VARCHAR(255) NOT NULL,
  content TEXT,
  node_key VARCHAR(500) NOT NULL,
  embedding DOUBLE PRECISION[],
  source_ref TEXT,
  source_type VARCHAR(50),
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  salience DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  quality DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  usage_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, node_key)
);

CREATE TABLE IF NOT EXISTS state_edges (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_node_id INTEGER NOT NULL REFERENCES state_nodes(id) ON DELETE CASCADE,
  target_node_id INTEGER NOT NULL REFERENCES state_nodes(id) ON DELETE CASCADE,
  relation VARCHAR(30) NOT NULL,
  weight DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  traversal_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, source_node_id, target_node_id, relation)
);

CREATE TABLE IF NOT EXISTS agent_state (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  agent_id VARCHAR(100) NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  current_context TEXT,
  reasoning_space JSONB NOT NULL DEFAULT '[]'::jsonb,
  meta_bridge TEXT,
  meta_embedding DOUBLE PRECISION[],
  turn_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, session_id, agent_id)
);

CREATE TABLE IF NOT EXISTS state_traversals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
  agent_id VARCHAR(100),
  query TEXT,
  goal TEXT,
  nodes_visited INTEGER[] NOT NULL DEFAULT '{}',
  edges_traversed INTEGER[] NOT NULL DEFAULT '{}',
  retrieved_nodes INTEGER[] NOT NULL DEFAULT '{}',
  decision TEXT,
  outcome VARCHAR(20) NOT NULL DEFAULT 'partial',
  evidence_used BOOLEAN NOT NULL DEFAULT FALSE,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_state_nodes_user_kind ON state_nodes(user_id, kind);
CREATE INDEX IF NOT EXISTS idx_state_nodes_user_session ON state_nodes(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_state_nodes_kind ON state_nodes(kind);
CREATE INDEX IF NOT EXISTS idx_state_nodes_last_seen ON state_nodes(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_state_nodes_fts ON state_nodes
  USING GIN (to_tsvector('simple', coalesce(label, '') || ' ' || coalesce(content, '')));
CREATE INDEX IF NOT EXISTS idx_state_edges_user_source ON state_edges(user_id, source_node_id);
CREATE INDEX IF NOT EXISTS idx_state_edges_user_target ON state_edges(user_id, target_node_id);
CREATE INDEX IF NOT EXISTS idx_state_edges_relation ON state_edges(relation);
CREATE INDEX IF NOT EXISTS idx_agent_state_user_session ON agent_state(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_agent_state_agent_id ON agent_state(agent_id);
CREATE INDEX IF NOT EXISTS idx_state_traversals_user_session ON state_traversals(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_state_traversals_created_at ON state_traversals(created_at DESC);

-- ============================================================================
-- Persistent User Profiles & Context Preferences
-- Stores durable user profile, bio, custom system instructions, and preferences
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name VARCHAR(100),
  about_user TEXT,
  global_instructions TEXT,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'update_user_profiles_updated_at'
      AND tgrelid = 'user_profiles'::regclass
  ) THEN
    CREATE TRIGGER update_user_profiles_updated_at
      BEFORE UPDATE ON user_profiles
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- ============================================================================
-- Semantic State Keyframes (Fast-Path Latency Reduction)
-- Stores pre-baked cognitive state snapshots to bypass multi-hop BFS and redundant
-- external embedding calls on consecutive turns.
-- ============================================================================

CREATE TABLE IF NOT EXISTS state_keyframes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  agent_id VARCHAR(100) NOT NULL,
  turn_anchor INTEGER NOT NULL DEFAULT 1,
  state_hash VARCHAR(64) NOT NULL,
  composite_embedding DOUBLE PRECISION[] NOT NULL DEFAULT '{}',
  drift_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.25,
  prebaked_prompt_block TEXT NOT NULL DEFAULT '',
  active_node_ids INTEGER[] NOT NULL DEFAULT '{}',
  active_concepts JSONB NOT NULL DEFAULT '[]'::jsonb,
  hit_count INTEGER NOT NULL DEFAULT 0,
  is_dirty BOOLEAN NOT NULL DEFAULT FALSE,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, session_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_state_keyframes_lookup
ON state_keyframes(user_id, session_id, agent_id);

