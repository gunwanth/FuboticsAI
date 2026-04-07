const axios = require("axios");
const { buildRagContext, indexWebSourcesForRag } = require("./ragService");
const knowledgeSourceModel = require("../models/knowledgeSource");
const knowledgeChunkModel = require("../models/knowledgeChunk");
const { executeCodeToolWithFallback } = require("./serenaConnector");

const SAMBANOVA_API_KEY = process.env.SAMBANOVA_API_KEY || null;
const SAMBANOVA_BASE_URL = process.env.SAMBANOVA_BASE_URL || "https://api.sambanova.ai/v1";
const SAMBANOVA_CHAT_MODEL = process.env.SAMBANOVA_CHAT_MODEL || "Meta-Llama-3.3-70B-Instruct";
const CODING_AGENT_MAX_ITERS = Math.max(1, Math.min(10, Number.parseInt(process.env.CODING_AGENT_MAX_ITERATIONS || "3", 10)));

function extractProviderError(err) {
  const status = err?.response?.status;
  const providerMessage =
    err?.response?.data?.error?.message ||
    err?.response?.data?.message ||
    err?.response?.data?.error ||
    err?.message ||
    "Unknown provider error";

  return status ? `HTTP ${status}: ${providerMessage}` : String(providerMessage);
}

/**
 * Helper to send chat completions to SambaNova API with structured tools
 */
async function sendSambaNovaCompletion(messages, tools = null, toolChoice = "auto") {
  if (!SAMBANOVA_API_KEY) {
    throw new Error("Coding Agent requires a valid SambaNova API Key.");
  }

  const payload = {
    model: SAMBANOVA_CHAT_MODEL,
    messages,
    temperature: 0.5,
    max_tokens: 4096,
  };

  if (tools) {
    payload.tools = tools;
    payload.tool_choice = toolChoice;
  }

  let response;
  try {
    response = await axios.post(`${SAMBANOVA_BASE_URL}/chat/completions`, payload, {
      headers: {
        Authorization: `Bearer ${SAMBANOVA_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 60000,
    });
  } catch (err) {
    throw new Error(`SambaNova completion failed: ${extractProviderError(err)}`);
  }

  return response.data.choices[0].message;
}

/**
 * Code-specific tools for the coding agent
 * Includes existing code analysis tools + Serena semantic tools
 */
const CODING_AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_codebase",
      description: "Search the project codebase for specific code patterns, functions, or errors.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query (e.g., 'API endpoints', 'function handleClick', 'database query')",
          },
          fileHint: {
            type: "string",
            description: "Optional file path hint to narrow search (e.g., 'services' or 'components')",
          },
          limit: {
            type: "integer",
            description: "Max results (default 20)",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_project_file",
      description: "Read a specific project file with line numbers for detailed code analysis.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to file relative to project root (e.g., 'src/App.jsx')",
          },
          startLine: {
            type: "integer",
            description: "Line number to start reading from (default 1)",
          },
          endLine: {
            type: "integer",
            description: "Line number to end reading (default start+119)",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_project_files",
      description: "List project files to navigate the codebase structure.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search/filter for specific files",
          },
          limit: {
            type: "integer",
            description: "Max files to return (default 120)",
          },
          onlyCode: {
            type: "boolean",
            description: "Only show code files (default true)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "store_code_knowledge",
      description: "Persist code analysis, bug fixes, or architecture patterns into the knowledge base.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Title of the code insight (e.g., 'React Hook Pattern')",
          },
          content: {
            type: "string",
            description: "Detailed explanation or code snippet",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags for categorization (e.g., 'bug-fix', 'optimization')",
          },
          knowledgeKind: {
            type: "string",
            description: "Type: 'code_analysis', 'bug_fix', 'pattern', 'optimization'",
          },
        },
        required: ["title", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_rag",
      description: "Search the knowledge base for previously stored code insights and patterns.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search for code patterns or solutions",
          },
          limit: {
            type: "integer",
            description: "Max results (default 6)",
          },
        },
        required: ["query"],
      },
    },
  },
];

/**
 * Keyword-based classifier to detect if a query is code-related
 * Returns score 0-100 where >=50 = code query
 */
function isCodeQuery(content) {
  const text = String(content || "").toLowerCase();

  const codeKeywords = [
    // Programming concepts
    "code", "function", "class", "method", "variable", "const", "let", "var",
    "import", "export", "require", "module", "async", "await", "promise",

    // Problem types
    "bug", "debug", "error", "fix", "refactor", "optimize", "test",
    "unit test", "jest", "mocha", "test case", "assertion",

    // Languages/frameworks (samples)
    "javascript", "python", "react", "vue", "angular", "nodejs",
    "typescript", "jsx", "tsx", "typescript", "sql", "html", "css",
    "rest api", "graphql", "webhook", "endpoint", "route",

    // Operations
    "write", "build", "generate", "create", "implement", "compile",
    "deploy", "version", "commit", "merge", "branch",

    // Architecture
    "design pattern", "architecture", "refactoring", "mvp", "component",
    "service", "controller", "middleware", "hook", "state management",

    // Common tasks
    "convert", "migrate", "upgrade", "downgrade", "lint", "format",
    "performance", "memory leak", "race condition", "deadlock",
  ];

  const negativeKeywords = [
    "weather", "sports", "news", "cooking", "recipe", "music",
    "travel", "vacation", "hotel", "restaurant", "movie", "book",
    "joke", "funny", "meme", "trivia", "history", "science",
  ];

  let score = 0;

  // Check code keywords
  for (const keyword of codeKeywords) {
    if (text.includes(keyword)) {
      score += 15;
      if (score > 100) score = 100;
    }
  }

  // Check negative keywords
  for (const keyword of negativeKeywords) {
    if (text.includes(keyword)) {
      score = Math.max(0, score - 20);
    }
  }

  // Check for code patterns
  if (/function\s+\w+|const\s+\w+\s*=|class\s+\w+|import\s+|export\s+|async\s+|await\s+|\{\s*\}|=>|\/\/|\/\*/.test(text)) {
    score = Math.min(100, score + 30);
  }

  // Boost if explicitly mentions code/coding/programming
  if (/\b(code|coding|programming|developer|engineer)\b/.test(text)) {
    score = Math.min(100, score + 20);
  }

  return score;
}

/**
 * Main agentic loop for code-related queries
 * Follows ReAct pattern: Think -> Act (tool use) -> Observe (results) -> Finalize
 */
async function runCodingAgentLoop(userId, sessionId, messages, model = "coding_agent", options = {}) {
  try {
    console.log(`[Coding Agent] Starting for user ${userId}, session ${sessionId}, model ${model}`);

    let iterations = 0;
    const maxIterations = CODING_AGENT_MAX_ITERS;
    const agentInstruction = String(options?.agentInstruction || "").trim();
    const agentLabel = String(options?.agentLabel || "Coding Agent").trim() || "Coding Agent";

    // Prepare conversation history - limit to last 5 messages to reduce payload
    const recentMessages = messages.slice(-5);
    const conversationHistory = recentMessages.map(m => ({
      role: m.role,
      content: String(m.content || "").slice(0, 2000) // Limit each message to 2000 chars
    }));

    // System instruction for coding agent
    const systemMessage = {
      role: "system",
      content: `You are CodingAgent, a specialized AI expert in software development, code analysis, and programming.
You are an elite coding companion that helps with:
- Writing and generating clean, efficient code
- Debugging and fixing bugs
- Refactoring and optimizing code
- Explaining code and architectural patterns
- Writing tests and test cases
- Code review and best practices
- Performance optimization

Your core loop: Understand requirement → Search codebase → Analyze → Plan → Execute → Finalize

When helping with code:
1. Always search the codebase first to understand context
2. Read relevant files to understand the problem
3. Provide concise, working code solutions
4. Include explanations when necessary
5. Store reusable patterns and fixes in the knowledge base

Be professional, precise, and focused on code quality. IMPORTANT: Keep responses concise and under 2000 characters.` + (agentInstruction ? `\n\nAdditional execution profile for this task (${agentLabel}):\n${agentInstruction}` : ""),
    };

    if (conversationHistory[0]?.role !== "system") {
      conversationHistory.unshift(systemMessage);
    }

    while (iterations < maxIterations) {
      iterations++;
      console.log(`[Coding Agent] Iteration ${iterations}/${maxIterations}...`);

      let assistantMessage;
      try {
        assistantMessage = await sendSambaNovaCompletion(conversationHistory, CODING_AGENT_TOOLS, "auto");
      } catch (err) {
        const message = String(err?.message || "");
        console.error("[Coding Agent] SambaNova API call failed:", message);

        // Some provider/model combinations reject tool-enabled payloads with 400s.
        // Retry once without tools so the user still gets a coding answer.
        if (message.includes("HTTP 400")) {
          console.warn("[Coding Agent] Retrying without tools after provider rejected tool request.");
          assistantMessage = await sendSambaNovaCompletion(conversationHistory, null, "auto");
        } else {
          throw err;
        }
      }
      conversationHistory.push(assistantMessage);

      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        console.log("[Coding Agent] Final answer reached.");
        // Truncate final response to 3000 chars to prevent payload overflow
        const finalResponse = String(assistantMessage.content || "").slice(0, 3000);
        return finalResponse;
      }

      // Process tool calls
      for (const toolCall of assistantMessage.tool_calls) {
        const name = toolCall?.function?.name;
        const argsString = toolCall?.function?.arguments;
        const toolId = toolCall?.id;
        let args;
        try {
          args = JSON.parse(argsString);
        } catch (e) {
          console.warn(`[Coding Agent] Failed to parse tool arguments for ${name}:`, argsString);
          conversationHistory.push({
            role: "tool",
            tool_call_id: toolId,
            name: name,
            content: "Error: Invalid JSON arguments provided to tool.",
          });
          continue;
        }

        console.log(`[Coding Agent Action] ${name}:`, args);
        let result;

        try {
          if (name === "search_codebase" || name === "read_project_file" || name === "list_project_files") {
            const toolResult = await executeCodeToolWithFallback(name, args, { requestedByAgent: agentLabel });
            result = toolResult.display;
          } else if (name === "search_rag") {
            const ragResult = await buildRagContext(userId, sessionId, args.query, args.limit || 6);
            result = (ragResult.context || "No relevant code patterns found in knowledge base.").slice(0, 1000);
          } else if (name === "store_code_knowledge") {
            const source = await knowledgeSourceModel.createInsight(
              userId,
              sessionId,
              args.title,
              args.content,
              {
                tags: Array.isArray(args.tags) ? args.tags : [],
                knowledge_kind: args.knowledgeKind || "code_analysis",
                learned_from_interaction: true,
                agent: "Coding Agent",
              }
            );

            const chunks = [{
              chunk_index: 0,
              content: args.content,
              token_count: String(args.content || "").split(/\s+/).filter(Boolean).length,
              metadata: { title: args.title, kind: args.knowledgeKind || "code_analysis" }
            }];

            await knowledgeChunkModel.replaceChunksForSource(source.id, userId, sessionId, chunks);
            result = `Stored: "${args.title}"`;
          } else {
            result = `Unknown tool: ${name}`;
          }
        } catch (err) {
          console.error(`[Coding Agent] Tool ${name} execution failed:`, err.message);
          result = `Error: ${err.message.slice(0, 200)}`;
        }

        conversationHistory.push({
          role: "tool",
          tool_call_id: toolId,
          name: name,
          content: String(result).slice(0, 500), // Limit tool results to 500 chars
        });
      }
    }

    const finalResp = conversationHistory[conversationHistory.length - 1].content || "";
    return String(finalResp).slice(0, 3000);
  } catch (outerErr) {
    console.error("[Coding Agent] Fatal error:", outerErr);
    throw outerErr;
  }
}

module.exports = {
  isCodeQuery,
  runCodingAgentLoop,
  CODING_AGENT_TOOLS,
};









