# Agentic RAG System Guide (Fubotics / NexaCore)

This document describes the Agentic AI + RAG foundations used in this repo: retrieval, web grounding, long-term memory, autonomous learning, routing, and the image-generation pipeline.

It is written as an engineering reference for how the current system works and how to extend it safely.

## Table Of Contents

- Goals and non-goals
- Architecture overview
- Where this is implemented (code map)
- Model separation and routing (standard models vs Dino agent)
- RAG foundations (knowledge base, chunking, retrieval)
- Autonomous retrieval and continuous learning (growth loop)
- Web retrieval and grounding (live RAG)
- Agentic AI (Dino): loop, tools, and state factors
- Image generation architecture (agentic pipeline + provider cascade)
- Chain flows (end-to-end)
- Operations and troubleshooting
- Extension guide and roadmap

## Goals And Non-Goals

Goals:

- Answer user queries with grounded context from:
- Uploaded files and extracted text.
- Previously indexed sources (session knowledge base).
- Live web retrieval when requested or needed.
- Maintain durable, queryable long-term memory that grows over time.
- Support an autonomous agent mode (Dino) that can plan tool usage and learn from outcomes.
- Keep "standard chat models" separate from the agent pipeline.

Non-goals:

- Perfect citation-style attribution (the current system appends links + knowledge refs; it is not a strict citation engine).
- Full semantic embeddings or vector DB (the current KB uses SQL + full-text search).

## High-Level Architecture

There are three major layers:

1. Chat + routing layer
- Receives user messages.
- Chooses between standard chat completion or agentic mode.
- Optionally triggers web retrieval, RAG context building, and learning.

2. Retrieval + knowledge layer (RAG)
- Stores sources (attachments, web sources, learned insights).
- Stores chunks of text for retrieval.
- Performs search against chunks and returns context + citations.

3. Tooling / generation layer
- Web search + page snippet extraction.
- Attachment extraction + indexing.
- Image generation pipeline (local worker, third-party providers, HF inference providers).

## Where This Is Implemented (Code Map)

The active routing and agent logic is implemented primarily in:

- `fubotics-chat-backend/index.js` (routing, model selection, web retrieval, agent loop, RAG context injection)

The KB models and schema live in:

- `fubotics-chat-backend/models/knowledgeSource.js`
- `fubotics-chat-backend/models/knowledgeChunk.js`
- `fubotics-chat-backend/database/schema.sql`

The model selector labels live in:

- `fubotics-chat-frontend/src/App.jsx`

If behavior looks wrong at runtime, start by reading `fubotics-chat-backend/index.js` end-to-end; it is the integration point that wires the system together.

## Model Separation And Routing (Standard vs Agent)

This repo intentionally separates:

- Standard chat models: single-pass chat completion (optionally with RAG + web context injected).
- Dino agent model: a multi-step tool-using loop that can do web retrieval, KB retrieval, and store new knowledge.

### User-Visible Model Names

The user-visible model names are:

- `groq` (standard model)
- `HF_1.0.1` (standard model)
- `Dino_1.0` (agent model, based on Hugging Face Router for chat completion)

### Design Rule (The Principle)

- Selecting `groq` or `HF_1.0.1` must not silently run the Dino tool loop.
- Selecting `Dino_1.0` must not silently "fall back" into standard model output unless an explicit fallback policy is configured.

This keeps routing deterministic: the selected model name corresponds to the actual behavior the user expects.

## RAG (Retrieval-Augmented Generation) Foundations

RAG is the pattern of:

1. Retrieve relevant context (documents, snippets, prior messages, web sources).
2. Inject that context into the prompt as grounding.
3. Generate a response that is constrained by the retrieved context.

In this repo, the RAG design is intentionally pragmatic:

- It uses a relational database as the knowledge store.
- It uses full-text search (PostgreSQL) to retrieve relevant chunks.
- It can ingest and index:
- Uploaded files (attachments).
- Web search results (URL + snippet).
- "Insights" learned by the agent.

### Knowledge Objects

The knowledge base is structured as:

- `knowledge_sources`
- One row per source item.
- Types include `attachment`, `web`, and `insight`.
- Stores title, URL (for web), metadata, and status.

- `knowledge_chunks`
- One row per chunk of text tied to a source.
- Contains the chunk content and metadata.

The retrieval is chunk-based. Chunks are created per source (attachments, web sources, or learned insights). Retrieval returns the best matching chunks based on full-text ranking.

### Knowledge Base Schema (Conceptual)

At a high level:

- A `knowledge_sources` row answers: "What is this thing we learned from?"
- A set of `knowledge_chunks` rows answers: "What text from that thing should be searchable?"

Typical source types:

- `attachment`: user-uploaded files (PDF/DOCX/TXT, optionally OCR for images)
- `web`: URL + snippet (or extracted text) from web retrieval
- `insight`: distilled, durable agent-generated notes meant for re-use

### Chunking Strategy (Pragmatic Baseline)

Chunking is the core quality lever of RAG.

The baseline strategy in this repo:

- Keep chunks large enough to preserve meaning (avoid 1-2 sentence fragments).
- Keep chunks small enough to retrieve precisely (avoid entire documents as one chunk).
- Store source metadata so you can trace any chunk back to origin.

If you later add semantic embeddings, keep this chunking baseline: embeddings also depend heavily on chunk boundaries.

### Retrieval Flow

When retrieval is triggered:

1. The system builds a query from the current user prompt.
2. It searches chunks scoped to the user and session (with some cross-session options).
3. It returns:
- `context`: the concatenated chunk content.
- `citations`: references that can be displayed as "Knowledge Base References".

The context is then appended into the system prompt for the LLM.

### Why This RAG Approach Works

Tradeoffs:

- Full-text search is fast and reliable with no embedding model dependency.
- It is explainable: results can be inspected in SQL.
- It is less semantically powerful than embeddings for paraphrases.

For many "assistant" workloads, this is a strong baseline: accurate recall for exact terms, file names, and key phrases, and predictable latency.

## Agentic AI (Dino) Concepts

An agent differs from standard chat completion in two ways:

1. It can use tools (web search, RAG search, store knowledge).
2. It can execute multiple iterations (plan, act, observe, refine).

The Dino model is implemented as a tool-using loop with a hard iteration limit, designed to:

- Ground answers in current web sources and stored knowledge.
- Learn durable new insights into the knowledge base.
- Operate in a controlled environment (max iterations, limited tool set).

### Agent Loop (ReAct-Style)

The "ReAct" structure is:

1. Think (internally): decide if a tool is needed.
2. Act: call one tool.
3. Observe: read tool output.
4. Repeat until final answer.

In code, the agent loop works like:

1. Send conversation + tool schema to the base LLM.
2. If it returns tool calls:
- Execute each tool.
- Append tool output back into the conversation.
3. If it returns a final assistant message:
- Return it to the user.

### Agent Router Phases

The system behaves like a router that can choose phases, depending on flags:

- Standard chat mode
- Optional deep web retrieval.
- Optional RAG grounding.

- Dino agent mode
- Web retrieval is preferred (and can be forced).
- Tool calls are allowed.
- Learning is enabled when agent mode is on.

This separation prevents standard models from accidentally performing tool-using loops, while still letting them benefit from RAG context and optional web retrieval.

### Agentic State Factors (The Switches That Change Behavior)

At runtime, behavior is controlled by a small set of "state factors" (request flags and environment flags). The names vary slightly across UI vs server, but conceptually they map to:

- Agent mode (Dino on/off)
  - OFF: run a standard completion (no tool loop).
  - ON: run the Dino loop (tools + iterations allowed).

- Web retrieval enabled (deep search)
  - OFF: answer from KB + conversation context only.
  - ON: the system may fetch live web sources to ground the answer.

- RAG enabled (KB retrieval)
  - OFF: no KB context injection.
  - ON: retrieve top chunks and inject them into the prompt.

- Always-web for Dino (prefetch)
  - OFF: Dino decides when to call web tools.
  - ON: Dino starts with web snippets already available as grounding.

- Self-learning enabled
  - OFF: Dino answers but does not write back to KB.
  - ON: Dino stores durable insights (and optionally indexes web snippets) to grow the KB.

Design requirement (to prevent server errors):

- If Dino is OFF, web retrieval and KB retrieval should still be able to run (when enabled) for standard models.
- If Dino is ON, web retrieval + KB retrieval + knowledge storing must be accessible to the agent loop.

## Autonomous Retrieval And Continuous Learning

Autonomous retrieval learning is what turns RAG from "lookup" into "continuous growth".

The core idea:

- Retrieve from web + KB to answer well now.
- Distill reusable knowledge from what you just used.
- Store that distilled knowledge back into the KB.
- Next time, retrieve from the expanded KB (faster, cheaper, more consistent).

There are two learning inputs:

1. Web learning
- When web sources are fetched, they can be indexed into the KB for later reuse.
- This allows future queries in the same session to reuse previous web results.

2. Agent learning (insights)
- When Dino derives a durable insight, it stores it as an `insight` source.
- The system splits it into chunks and stores them.
- Future retrieval can find these insights.

This creates a feedback loop:

- Retrieve from KB and web.
- Answer with grounding.
- Store durable knowledge.
- Retrieve later from the expanded KB.

Important constraint:

- You should not store sensitive user secrets or tokens in the KB.
- Only store durable, reusable information.

### What Counts As "Durable Knowledge"

Good examples:

- Steps/checklists (deployment, debugging, operations).
- Project architecture notes (endpoints, data flows, which service does what).
- Stable facts learned from a trusted source (documentation, user-provided specs).
- Summaries of long attachments or web pages, clearly labeled as summaries.

Bad examples:

- Access tokens, API keys, passwords.
- One-off conversational chatter.
- Unverified claims from random web sources stored as fact (store as `web` with URL instead).

### Learning Phases (Recommended Implementation Model)

Even if the code implements a lightweight version today, the conceptual phases are:

1. Collect
- Capture the web snippets + KB chunks used during the answer.

2. Distill
- Produce a short reusable note (title + content).
- Prefer structured content: bullet steps, constraints, definitions.

3. Validate
- Ensure no secrets.
- Ensure it is not too long.
- Ensure it is generalized (not "in this chat I said...").

4. Store
- Save as `insight` source + one or more chunks.

5. Reuse
- Future queries can recall this via `search_rag`.

## Web Retrieval (Deep Search)

The system includes a lightweight web retrieval mechanism:

- It searches using DuckDuckGo HTML results.
- It normalizes result URLs.
- It fetches a small number of pages and extracts paragraph text snippets.
- It returns a list of sources: `{ title, url, snippet }`.

These sources can be:

- Shown in the final answer as links.
- Indexed into the KB as `web` sources.

This is intentionally "snippet-first" to keep latency and payload sizes controlled.

### Web Grounding (How We Reduce Hallucinations)

Grounding is implemented by:

- Injecting retrieved snippets/chunks into the prompt as context.
- Instructing the model to prefer provided context over guessing.
- Returning the relevant URLs and KB references (so the UI can show provenance).

Even when Dino agent mode is OFF, web retrieval should still be able to run (if enabled) to ground standard model answers.

## How Standard Models Use RAG And Web (Without Agent Mode)

Standard models can use:

- Uploaded file summaries and extracted text.
- Optional deep web retrieval (when enabled).
- Optional RAG context injection.

But they do not:

- Execute tool calls.
- Store knowledge automatically (unless explicitly implemented).
- Iterate as an autonomous loop.

This keeps costs and latency lower for normal chat usage.

## Knowledge Base Scope

The KB is keyed by:

- `user_id` (ownership).
- `session_id` (conversation thread).

Retrieval can be scoped:

- Session-only (preferred for relevance).
- Cross-session (optional, controlled by router logic).

This prevents "memory bleed" across users and helps keep context relevant.

## Agent Safety And Guardrails

Key guardrails that keep the system stable:

- Iteration limit for the agent loop.
- Small tool set (only search, web, store).
- Timeouts for web fetches.
- Chunk size and snippet truncation limits.

Recommended extra guardrails (future):

- Source allow/deny lists for web fetch.
- HTML extraction hardening.
- Token budget accounting for tool outputs.
- Deduplication and summarization for stored web sources.

## Image Generation Architecture

Image generation is implemented as a provider pipeline.

The pipeline works like:

1. Prompt refinement
- Optionally use an LLM to refine the user prompt into a better text-to-image prompt.
- This is done once and then reused for all providers.

2. Provider cascade
- Try providers in order until one succeeds.
- Store which provider succeeded in attachment metadata.

Typical providers:

- Local worker (`LOCAL_IMAGE_WORKER_URL`)
- Freepik (if enabled)
- Hugging Face Inference Providers text-to-image (router endpoint)
- Pollinations fallback (optional)
- Placeholder fallback (optional)

### Why A Cascade

Image providers vary in:

- Availability and rate limits.
- Latency and quality.
- Cost and credentials.

A cascade gives resilience: the system still generates an image even when one provider is down (unless configured to fail hard).

### Agentic Image Generation (Chain + Routing)

Image generation is "agentic" as a chain flow:

1. Interpret intent and constraints:
- subject, style, resolution, aspect ratio, "no text", etc.

2. Prompt refinement:
- Convert vague prompts into concrete image prompts.
- Preserve the refined prompt as metadata for debugging.

3. Provider routing:
- Try the best available provider first (local worker if present).
- Fall back to HF inference provider (if configured and permitted).
- Continue fallbacks until success or until configured to fail.

4. Retry and backoff:
- Handle 429 rate limits with backoff.
- Poll async jobs until ready (provider dependent).

5. Persist and attach:
- Write to `generated/`
- Register an attachment linked to the chat message

## Chain Flows (End-to-End)

### Standard Chat With Optional RAG

1. User message arrives.
2. Attachments and session context are loaded.
3. If deep search enabled:
- Fetch web sources.
- Optionally index into KB.
4. Build RAG context and citations.
5. Send completion to the selected standard model.
6. Store assistant message.

### Dino Agent Mode (Autonomous)

1. User message arrives.
2. Dino agent loop starts.
3. Optionally prefetch web sources to seed grounding.
4. Agent iterates:
- Calls `deep_search_web` for live sources.
- Calls `search_rag` for stored sources.
- Calls `store_knowledge` to save durable insights.
5. Final answer is returned and stored.
6. If learning enabled:
- Run a background learning pass to store additional durable insights.

### Image Generation

1. Detect "generate image" request.
2. Build refined prompt.
3. Try providers sequentially.
4. Save image as attachment and link to message.

## Operational Notes

### Token And Permission Management

Hugging Face Router (Inference Providers) requires:

- A token with Inference Providers permission enabled.
- Correct base URLs:
- Chat: `https://router.huggingface.co/v1/chat/completions`
- Text-to-image provider route: `https://router.huggingface.co/hf-inference/models/<model>`

If you see 403 errors mentioning Inference Providers, it is a token permission problem, not a request format problem.

### Rate Limits (429) And Backoff

Some providers will respond with `HTTP 429` under load.

Operational best practice:

- Respect `Retry-After` when present.
- Exponential backoff with an upper bound.
- Give the user a clear "retry/switch model" path.

### Avoid Committing Secrets

- Keep `.env` untracked.
- Do not paste tokens into `.env.example`.
- Prefer `HF_TOKEN`, `GROQ_API_KEY`, etc. in local environment only.

## Extending The System

Safe ways to extend:

- Add a new `knowledge_sources.source_type` and index it into chunks.
- Add a new tool to Dino:
- Define JSON schema.
- Implement execution and tool output formatting.
- Consider iteration limits and timeouts.

- Add an embedding-based retrieval path:
- Keep the existing full-text search as fallback.
- Add a feature flag and instrumentation.

Risky ways to extend (avoid without guardrails):

- Unlimited tool access.
- Unlimited web crawling.
- Storing raw web pages without truncation/sanitization.
- Storing sensitive user content as "insight".

## Roadmap (Recommended Next Upgrades)

If you want this system to get significantly smarter without getting fragile:

- Deduplication:
  - hash URLs and avoid storing the same web source repeatedly
  - merge repeated insights by title/topic

- Knowledge quality scoring:
  - store confidence and usage counts per source
  - prefer sources that have been repeatedly helpful

- Add embeddings as an optional lane:
  - semantic recall for paraphrases
  - keep full-text search as a deterministic fallback

- Improve citations:
  - encourage per-claim provenance
  - rank sources by trust level (docs > blogs > unknown)

## MCP Server

The repo now also includes a standalone MCP server under:

- `fubotics-chat-backend/mcp-server/server.js`

This server exposes Dino-oriented tools over MCP so an external agent runner can orchestrate:

- `search_rag`
- `deep_search_web`
- `store_knowledge`
- `token_policy_inspect`

This is useful when you want a client-side or external orchestration layer to drive Dino as a self-running tool user while still writing learned knowledge back into the same PostgreSQL knowledge base.

Important:

- This improves agent interoperability and autonomy.
- It does not by itself retrain the base LLM.
- It enables long-term memory growth and tool-based autonomy through MCP.

## Troubleshooting

If retrieval seems wrong:

- Check `knowledge_sources` status is `ready`.
- Confirm chunks exist for the source.
- Inspect the query text used for retrieval.
- Confirm the session/user scoping is correct.

If the agent loops too long:

- Reduce `DINO_AGENT_MAX_ITERATIONS`.
- Reduce web max results and snippet sizes.
- Reduce token budgets for the model.

If image generation fails:

- Verify at least one provider is configured.
- Check HF token permission if using HF inference providers.
- Check local worker reachability and API key.

## Glossary

- RAG: Retrieval-Augmented Generation.
- KB: Knowledge base (sources + chunks).
- Agent: A multi-step LLM workflow with tools.
- Tool call: A structured action requested by the LLM (search, web, store).
- Grounding: Adding retrieved context to reduce hallucinations.
