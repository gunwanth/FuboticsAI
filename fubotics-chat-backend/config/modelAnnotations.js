const DEFAULT_INPUT_CHARS_PER_TOKEN = 4;

function estimatePromptTokens(text) {
  const value = String(text || "");
  return Math.max(1, Math.ceil(value.length / DEFAULT_INPUT_CHARS_PER_TOKEN));
}

function classifyTokenBudget({
  promptText = "",
  hasAttachments = false,
  usesWeb = false,
  usesAgentLoop = false,
  requestedMaxTokens = 0,
  lightningMode = false,
} = {}) {
  const promptTokens = estimatePromptTokens(promptText);
  const baseRequested = Math.max(0, Number(requestedMaxTokens) || 0);

  if (lightningMode) {
    return {
      tier: usesAgentLoop ? "lightning_agentic" : "lightning",
      promptTokens,
      outputBudget: Math.max(
        baseRequested,
        usesAgentLoop ? 1280 : usesWeb || hasAttachments ? 1024 : 768
      ),
      sparsity: "very_high",
      notes: [
        "Prioritize precise direct answers over exhaustive detail.",
        "Use fewer web sources and shorter evidence windows.",
        "Finalize earlier once enough evidence is available.",
      ],
    };
  }

  if (usesAgentLoop) {
    return {
      tier: "agentic",
      promptTokens,
      outputBudget: Math.max(baseRequested, 3072),
      sparsity: "high",
      notes: [
        "Prefer tool calls over long free-form reasoning.",
        "Compress tool observations before re-injection.",
        "Persist durable knowledge to RAG instead of repeating it in-context.",
      ],
    };
  }

  if (usesWeb || hasAttachments || promptTokens > 2200) {
    return {
      tier: "extended_context",
      promptTokens,
      outputBudget: Math.max(baseRequested, 2048),
      sparsity: "medium",
      notes: [
        "Trim repetitive snippets.",
        "Keep only top-ranked sources/chunks.",
        "Use compact citations instead of repeating evidence.",
      ],
    };
  }

  return {
    tier: "standard",
    promptTokens,
    outputBudget: Math.max(baseRequested, 1024),
    sparsity: "low",
    notes: [
      "Default conversational budget.",
      "Avoid unnecessary chain-of-thought expansion.",
    ],
  };
}

const MODEL_ANNOTATIONS = {
  groq: {
    id: "groq",
    role: "standard_llm",
    provider: "Groq",
    behavior: "fast_general_chat",
    learningMode: "none",
    toolAccess: "none",
    retrievalAccess: ["rag_injection", "optional_web_grounding"],
    tokenPolicy: {
      inputCompression: "moderate",
      outputStyle: "concise_answer_first",
      sparsityStrategy: "drop_low_signal_context_before_generation",
      defaultOutputBudget: 2048,
    },
    annotationTags: ["standard", "non-agentic", "chat-completions"],
  },
  sambanova: {
    id: "sambanova",
    role: "standard_llm",
    provider: "SambaNova",
    behavior: "general_chat_and_generation_support",
    learningMode: "none",
    toolAccess: "none",
    retrievalAccess: ["rag_injection", "optional_web_grounding"],
    tokenPolicy: {
      inputCompression: "moderate",
      outputStyle: "grounded_answer_with_refs",
      sparsityStrategy: "prefer_ranked_context_over_full_raw_sources",
      defaultOutputBudget: 2048,
    },
    annotationTags: ["standard", "non-agentic", "router-backed"],
  },
  dino: {
    id: "dino",
    role: "agentic_llm",
    provider: "Groq base + Dino agent loop",
    behavior: "web_connected_autonomous_reasoning",
    learningMode: "rag_memory_growth",
    toolAccess: ["search_rag", "deep_search_web", "store_knowledge"],
    retrievalAccess: ["rag_search", "web_prefetch", "cross_chat_context"],
    tokenPolicy: {
      inputCompression: "aggressive",
      outputStyle: "tool_then_finalize",
      sparsityStrategy: "externalize_memory_to_rag_and_keep_loop_context_small",
      defaultOutputBudget: 3072,
    },
    annotationTags: ["agent", "self-learning-memory", "web-grounded", "react-loop"],
  },
  coding_agent: {
    id: "coding_agent",
    role: "coding_specialist_agent",
    provider: "Groq base + Coding agent loop",
    behavior: "dedicated_code_analysis_and_generation",
    learningMode: "code_insights_tagged",
    toolAccess: [
      "search_codebase",
      "read_project_file",
      "list_project_files",
      "search_rag",
      "store_code_knowledge",
    ],
    retrievalAccess: ["code_rag_search", "project_context"],
    tokenPolicy: {
      inputCompression: "aggressive",
      outputStyle: "code_first_then_explanation",
      sparsityStrategy: "externalize_code_snippets_to_rag",
      defaultOutputBudget: 4096,
    },
    annotationTags: ["code-specialist", "react-loop", "code-focused"],
  },
};

const AGENT_ANNOTATIONS = {
  dino_agent: {
    id: "dino_agent",
    loopStyle: "react",
    phases: ["think", "act", "observe", "finalize"],
    maxIterationsEnv: "DINO_AGENT_MAX_ITERATIONS",
    longTermMemory: "knowledge_sources + knowledge_chunks",
    selfLearning: "distill_and_store_reusable_insights",
    sparsityControls: [
      "limit web results",
      "truncate snippets",
      "store summaries externally",
      "avoid repeating full tool output in every turn",
    ],
  },
  coding_agent: {
    id: "coding_agent",
    loopStyle: "react",
    phases: ["understand_requirement", "search_codebase", "analyze", "plan", "finalize_code"],
    maxIterationsEnv: "CODING_AGENT_MAX_ITERATIONS",
    longTermMemory: "code_insights + architecture_notes + patterns",
    selfLearning: "store_code_patterns_and_fixes",
    sparsityControls: [
      "limit codebase results",
      "truncate large files",
      "store reusable patterns externally",
      "focus on relevant code sections",
    ],
  },
};

module.exports = {
  MODEL_ANNOTATIONS,
  AGENT_ANNOTATIONS,
  estimatePromptTokens,
  classifyTokenBudget,
};


