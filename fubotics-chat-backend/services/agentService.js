const axios = require("axios");
const { buildRagContext, indexWebSourcesForRag } = require("./ragService");
const knowledgeSourceModel = require("../models/knowledgeSource");
const knowledgeChunkModel = require("../models/knowledgeChunk");

const SAMBANOVA_API_KEY = process.env.SAMBANOVA_API_KEY || null;
const SAMBANOVA_BASE_URL = process.env.SAMBANOVA_BASE_URL || "https://api.sambanova.ai/v1";

/**
 * Helper to send chat completions to the Web-based LLM API (SambaNova)
 */
async function sendWebCompletion(messages, tools = null, toolChoice = "auto") {
  if (!SAMBANOVA_API_KEY) {
    throw new Error("Dino 1.0 Agent requires a valid Web LLM API Key (SambaNova).");
  }

  const payload = {
    model: process.env.SAMBANOVA_CHAT_MODEL || "Meta-Llama-3.3-70B-Instruct",
    messages,
    temperature: 0.5,
    max_tokens: 4096,
  };

  if (tools) {
    payload.tools = tools;
    payload.tool_choice = toolChoice;
  }

  const response = await axios.post(`${SAMBANOVA_BASE_URL}/chat/completions`, payload, {
    headers: {
      Authorization: `Bearer ${SAMBANOVA_API_KEY}`,
      "Content-Type": "application/json",
    },
    timeout: 60000,
  });

  return response.data.choices[0].message;
}

const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_rag",
      description: "Search the knowledge base for information from uploaded files or previous deep searches in this session.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The specific search query to look for in the knowledge base.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deep_search_web",
      description: "Perform a live web search to find the latest information on a topic.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query for the web search.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "store_knowledge",
      description: "Learn and store a new fact, summary, or insight into the long-term knowledge base. Use this to 'learn' from the current conversation.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "A short descriptive title for this piece of knowledge.",
          },
          content: {
            type: "string",
            description: "The detailed insight, fact, or summary to store.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional tags for categorization.",
          },
        },
        required: ["title", "content"],
      },
    },
  },
];

/**
 * Agentic loop for reasoning and tool use.
 */
async function runAgentLoop(userId, sessionId, messages, model = "llama-3.3-70b-versatile", deepSearchWebFn) {
  try {
    console.log(`[Agent Loop] Starting for user ${userId}, session ${sessionId}, model ${model}`);
    let iterations = 0;
    const maxIterations = 5;
    
    // CLEANUP: Ensure messages only have role and content for the LLM API
    const conversationHistory = messages.map(m => ({
      role: m.role,
      content: m.content || ""
    }));

    // System instruction for the agentic reasoning
    const systemMessage = {
      role: "system",
      content: `You are Dino 1.0, an advanced LLM with autonomous Web-Connected capabilities by NexaCore.
You are powered by a high-speed Web AI brain and specialized in real-time information retrieval.

Your core ReAct Loop: Think -> Act -> Observe -> Finalize.

Your primary missions as a Web-Connected Agent:
1. Dynamic Web Intelligence: Use 'deep_search_web' to fetch real-time data from the internet. You are the bridge between the user and the live web.
2. Long-Term Memory: Use 'store_knowledge' to learn from every search and interaction. This builds your evolving intelligence.
3. RAG Grounding: Use 'search_rag' to access previously learned facts and uploaded files.
4. Professional Reasoning: You must explain your reasoning clearly before using tools.

Identity: You are Dino 1.0. You represent the cutting edge of Web-Integrated AI.`,
    };

    // Ensure system message is at the start
    if (conversationHistory[0]?.role !== "system") {
      conversationHistory.unshift(systemMessage);
    }

    while (iterations < maxIterations) {
      iterations++;
      console.log(`[Agent Loop] Iteration ${iterations}...`);

      const assistantMessage = await sendWebCompletion(conversationHistory, AGENT_TOOLS, "auto").catch(err => {
        console.error("[Agent Loop] Web LLM API call failed:", err.message);
        throw err;
      });
      conversationHistory.push(assistantMessage);

      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        console.log("[Agent Loop] Final answer reached.");
        return assistantMessage.content;
      }

      // Process tool calls
      for (const toolCall of assistantMessage.tool_calls) {
        const { name, arguments: argsString } = toolCall.function;
        let args;
        try {
          args = JSON.parse(argsString);
        } catch (e) {
          console.warn(`[Agent Loop] Failed to parse tool arguments for ${name}:`, argsString);
          conversationHistory.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: name,
            content: "Error: Invalid JSON arguments provided to tool.",
          });
          continue;
        }

        console.log(`[Agent Action] ${name}:`, args);
        let result;

        try {
          if (name === "search_rag") {
            const ragResult = await buildRagContext(userId, sessionId, args.query, 8);
            result = ragResult.context || "No relevant information found in the knowledge base.";
          } else if (name === "deep_search_web") {
            const sources = await deepSearchWebFn(args.query);
            if (sources && sources.length > 0) {
              await indexWebSourcesForRag(userId, sessionId, sources);
              result = sources.map(s => `Title: ${s.title}\nURL: ${s.url}\nSnippet: ${s.snippet}`).join("\n\n");
            } else {
              result = "No results found on the web.";
            }
          } else if (name === "store_knowledge") {
            const source = await knowledgeSourceModel.createInsight(
              userId,
              sessionId,
              args.title,
              args.content,
              { tags: args.tags || [], learned_from_interaction: true, agent: "Dino 1.0" }
            );
            
            const chunks = [{
              chunk_index: 0,
              content: args.content,
              token_count: args.content.split(/\s+/).length,
              metadata: { title: args.title }
            }];
            
            await knowledgeChunkModel.replaceChunksForSource(source.id, userId, sessionId, chunks);
            result = `Successfully stored insight: "${args.title}" into long-term knowledge.`;
          }
        } catch (err) {
          console.error(`[Agent Loop] Tool ${name} execution failed:`, err);
          result = `Error executing ${name}: ${err.message}`;
        }

        conversationHistory.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: name,
          content: String(result),
        });
      }
    }

    return "I reached my reasoning limit without a final answer. Here is my last thought: " + (conversationHistory[conversationHistory.length - 1].content || "");
  } catch (outerErr) {
    console.error("[Agent Loop] Fatal error:", outerErr);
    throw outerErr;
  }
}

/**
 * Background learning function for when other models are answering.
 * It summarizes the interaction and stores it as knowledge.
 */
async function runAgentLearning(userId, sessionId, userMessage, assistantReply) {
  try {
    const learningPrompt = `You are Dino 1.0, the autonomous learning agent for NexaCore.
Your current task is to LEARN from an interaction between a User and another AI Model.

INTERACTION:
User: "${userMessage}"
Assistant: "${assistantReply}"

TASK:
1. Extract any new facts, insights, or high-quality summaries from this interaction.
2. Use the 'store_knowledge' tool to save these into the long-term knowledge base.
3. If the interaction contains no valuable information, do nothing.

Reason step-by-step and then use the tool if needed.`;

    const message = await sendWebCompletion([{ role: "system", content: learningPrompt }], AGENT_TOOLS, "auto");
    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.function.name === "store_knowledge") {
          const args = JSON.parse(toolCall.function.arguments);
          const source = await knowledgeSourceModel.createInsight(
            userId,
            sessionId,
            args.title,
            args.content,
            { tags: args.tags || [], learned_from_interaction: true, agent: "Dino 1.0" }
          );
          
          const chunks = [{
            chunk_index: 0,
            content: args.content,
            token_count: args.content.split(/\s+/).length,
            metadata: { title: args.title }
          }];
          
          await knowledgeChunkModel.replaceChunksForSource(source.id, userId, sessionId, chunks);
          console.log(`[Agent Learning] Dino 1.0 successfully learned: "${args.title}"`);
        }
      }
    }
  } catch (err) {
    console.error("[Agent Learning] Failed to learn from interaction:", err.message);
  }
}

module.exports = {
  runAgentLoop,
  runAgentLearning,
};
