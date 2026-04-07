# Token Usage, Sparsity, And LLM / Agent Annotation

This note defines the current token-handling baseline for the Fubotics / NexaCore stack.

## Purpose

The project now has three distinct runtime classes:

- `groq`
- `HF_1.0.1`
- `Dino_1.0`

These should not be treated as identical inference paths. They have different:

- latency profiles
- retrieval behavior
- tool access
- learning behavior
- token pressure

To make that explicit, the backend now exposes annotations from:

- `fubotics-chat-backend/config/modelAnnotations.js`

And publishes them through:

- `GET /api/models`
- `POST /api/token-policy/inspect`

## Core Distinction

### Standard LLMs

- `groq`
- `HF_1.0.1`

These are standard chat-completion models.

They may receive:

- RAG context
- attachment-derived context
- optional web-grounding snippets

But they do not run the autonomous tool loop.

### Agentic LLM

- `Dino_1.0`

Dino is not just a chat model label. It is:

- a Groq-based base LLM
- plus the Dino agent loop
- plus web retrieval
- plus RAG search
- plus knowledge writeback

This means Dino must be annotated separately from standard models.

## Token Handling

The backend now uses three token policy tiers:

### 1. Standard

Used when:

- prompt is relatively small
- no attachment-heavy context
- no web-heavy context
- no agent loop

Behavior:

- low sparsity
- keep normal conversational context
- default output budget around `1024`

### 2. Extended Context

Used when:

- prompt is larger
- attachments are present
- web grounding is active

Behavior:

- medium sparsity
- trim repetitive snippets
- prefer top-ranked KB / web evidence
- default output budget around `2048`

### 3. Agentic

Used when:

- Dino agent loop is active

Behavior:

- high sparsity
- push durable information into RAG instead of keeping it all in-loop
- keep tool observations compact
- prefer short action/observation cycles
- default output budget around `3072`

## Sparsity Meaning In This Project

Sparsity here does not mean neural-weight sparsity.

It means inference-time context sparsity:

- remove low-signal context
- keep only top-ranked retrieved chunks
- cap web results
- shorten snippets
- avoid repeating full tool outputs
- externalize reusable memory into the knowledge base

This is the correct first step before trying model fine-tuning.

## Current Learning Interpretation

`Dino_1.0` currently learns as memory growth, not model-weight training.

It can learn from:

- chats
- web retrieval
- uploaded files / extracted media text

It stores durable knowledge into:

- `knowledge_sources`
- `knowledge_chunks`

This is:

- self-learning as agent memory

This is not:

- fine-tuning
- LoRA training
- checkpoint updates

## Why Annotation Matters

Without explicit annotation, all models look the same to the system.

That causes problems such as:

- wrong token budgets
- too much context passed to fast models
- agent loops becoming bloated
- repeated tool outputs wasting tokens
- confusion between "chat model" and "agent model"

The annotation layer fixes that by assigning:

- role
- provider
- behavior
- tool access
- retrieval access
- learning mode
- token policy
- sparsity strategy

## Next Recommended Step

After this annotation baseline, the next practical work should be:

1. add real token telemetry per request
2. log prompt size, retrieved chunk count, and web snippet count
3. track per-model average output length
4. add trimming before generation instead of only static budgets
5. expose this in admin diagnostics

That is the right path before moving toward embeddings, LoRA, or model-serving upgrades.
