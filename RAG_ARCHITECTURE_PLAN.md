# NexaCore RAG Architecture Plan

## Goal
Add a Retrieval-Augmented Generation architecture to NexaCore so answers are grounded on uploaded files, extracted resources, deep-search pages, and approved historical chat knowledge.

This architecture is designed for the current stack:
- Frontend: React
- Backend: Node.js / Express
- Database: PostgreSQL
- Existing features: persistent chat sessions, attachments, file extraction, deep search, generated files, shareable chats, multi-model chat

## Primary Design Rule
The model must not "learn" by changing weights from each query or output.

Instead:
- source data is extracted and indexed
- relevant knowledge is retrieved per request
- the answer is generated from retrieved context
- only approved or curated outputs are written back into long-term knowledge

This avoids feedback loops and hallucination amplification.

## Target Outcome
The system should support:
- grounded answers from uploaded files
- grounded answers from web research
- scoped retrieval from current session, user history, or shared knowledge
- citations in answers
- asynchronous indexing pipelines
- reusable knowledge storage for future chats

## Core Architecture

### 1. Ingestion Layer
Responsible for turning raw resources into normalized text.

Sources:
- uploaded files
- generated files
- deep-search web pages
- selected chat summaries
- manually added knowledge

Responsibilities:
- detect source type
- extract text
- normalize content
- collect metadata

### 2. Chunking Layer
Responsible for splitting extracted text into retrieval-ready units.

Rules:
- chunk size around 300 to 800 tokens
- overlap around 50 to 120 tokens
- preserve metadata per chunk
- preserve page/section/file identifiers where available

### 3. Embedding Layer
Responsible for turning chunks into vectors.

Requirements:
- one embedding per chunk
- embeddings stored in PostgreSQL with pgvector
- metadata stored alongside embeddings

### 4. Retrieval Layer
Responsible for selecting the best chunks for a query.

Retrieval types:
- semantic similarity
- keyword search
- metadata filtering
- session-scoped retrieval
- user-scoped retrieval

Recommended approach:
- hybrid retrieval first
- rerank top results before final prompt assembly

### 5. Generation Layer
Responsible for grounded answer generation.

Prompt should include:
- system instruction
- recent message history
- retrieved chunks
- source list
- active mode flags such as deep search or thinking

The model should be instructed to:
- prioritize retrieved context
- cite sources when possible
- say when evidence is insufficient

### 6. Memory Writeback Layer
Responsible for controlled long-term knowledge growth.

Allowed writes:
- extracted source content
- approved summaries
- user-confirmed notes
- curated project knowledge

Disallowed writes:
- raw model outputs without validation
- unsupported inferences treated as truth

## Retrieval Scopes

### Session Scope
Use only:
- current chat attachments
- extracted resources linked to the active session
- web sources indexed for the current session

### User Scope
Use:
- all approved user knowledge
- all indexed user files
- selected prior session summaries

### Shared Scope
Use:
- public or shared resources that belong to the shared chat context

### Global Scope
Optional future layer for:
- common organization documents
- system-wide reusable knowledge

## Database Design

### Required Extension
- `pgvector`

### Proposed Tables

#### `knowledge_sources`
Stores one record per ingested resource.

Columns:
- `id`
- `user_id`
- `session_id`
- `attachment_id`
- `source_type`
- `title`
- `url`
- `status`
- `metadata`
- `created_at`
- `updated_at`

#### `knowledge_chunks`
Stores chunked text plus embeddings.

Columns:
- `id`
- `source_id`
- `user_id`
- `session_id`
- `chunk_index`
- `content`
- `token_count`
- `embedding`
- `metadata`
- `created_at`

#### `knowledge_jobs`
Tracks async indexing work.

Columns:
- `id`
- `source_id`
- `job_type`
- `status`
- `error_message`
- `created_at`
- `updated_at`

#### `knowledge_feedback`
Optional future table for writeback approval.

Columns:
- `id`
- `user_id`
- `message_id`
- `feedback_type`
- `approved`
- `notes`
- `created_at`

## Backend Modules

### `services/extractorService.js`
Responsibilities:
- extract text from files
- normalize web page content
- return plain text plus metadata

### `services/chunkingService.js`
Responsibilities:
- tokenize text approximately
- split into chunks
- attach overlap and source metadata

### `services/embeddingService.js`
Responsibilities:
- generate embeddings
- batch embed chunks when needed

### `services/retrievalService.js`
Responsibilities:
- run semantic retrieval
- run keyword retrieval
- merge and score candidates

### `services/rerankService.js`
Responsibilities:
- rerank top retrieved chunks
- keep only the highest-signal context

### `services/ragAnswerService.js`
Responsibilities:
- build final grounded prompt
- inject retrieved context into model call

### `services/knowledgeIngestionService.js`
Responsibilities:
- orchestrate source -> extract -> chunk -> embed -> store

## API Integration Plan

### Existing Message Flow
Current main path:
- `/api/messages`
- `/api/messages/:id`

Target RAG insertion point:
- after request normalization
- before `getAIReply(...)`

New flow:
1. detect whether query needs retrieval
2. retrieve relevant knowledge
3. build grounded prompt
4. call selected model
5. return answer with source references

### Existing Attachment Flow
Current file upload already stores attachments.

Target RAG update:
1. upload attachment
2. extract text
3. create `knowledge_sources`
4. queue indexing job
5. store chunks and embeddings

### Existing Deep Search Flow
Current deep search fetches web pages and snippets.

Target RAG update:
1. fetch source pages
2. extract readable content
3. store as indexed web sources
4. retrieve against them in later questions

## Frontend Integration Plan

### Chat Composer
Add optional retrieval mode indicators:
- session knowledge
- user knowledge
- web-grounded answer

### Message UI
Answers should support:
- inline citations
- source cards
- retrieved context summaries

### File UI
Uploaded files should display indexing state:
- uploaded
- extracting
- indexing
- ready
- failed

## Ranking Strategy

### Phase 1
- semantic top 8
- keyword top 8
- merge by source and score

### Phase 2
- rerank top 10 candidates
- keep top 4 to 6 chunks

### Phase 3
- diversify by source
- avoid sending five chunks from the same file unless query is narrow

## Safety Rules
- never index secrets from `.env`
- never expose another user's indexed chunks
- always scope retrieval by `user_id` or approved public scope
- never write raw model outputs back into knowledge automatically

## Performance Rules
- indexing should be asynchronous
- chat requests should not block on large file embedding
- use chunk batching for embeddings
- add indexes on source ownership and timestamps

## Implementation Phases

### Phase 1. Schema and Base Services
- add pgvector support
- add knowledge tables
- add extractor, chunking, and embedding services

### Phase 2. File RAG
- index uploaded files
- retrieve file context in `/api/messages`

### Phase 3. Deep Search RAG
- persist web research as retrievable sources
- allow follow-up questions over prior web results

### Phase 4. Cross-Session Knowledge
- retrieve from all approved user knowledge
- add retrieval scope controls

### Phase 5. Controlled Memory Writeback
- store approved summaries and curated notes
- build reusable user knowledge graph gradually

## Recommended First Build Step
Start with file-based RAG only.

Why:
- highest signal
- easiest to validate
- least architectural risk
- directly improves current upload and extraction workflows

## Definition of Done for Initial RAG Release
- uploaded files are indexed into chunked knowledge
- `/api/messages` retrieves relevant chunks for qualifying questions
- answers are grounded on indexed context
- source references are returned with responses
- indexing status is visible in the UI

