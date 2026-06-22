const axios = require("axios");

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || null;
const NVIDIA_BASE_URL = process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";
const NVIDIA_EMBEDDING_MODEL = process.env.NVIDIA_EMBEDDING_MODEL || "nvidia/llama-nemotron-embed-1b-v2";

/**
 * Generates embeddings for an array of texts.
 * @param {string|string[]} texts - Single text string or array of strings.
 * @param {"passage"|"query"} inputType - The input type required by NVIDIA embedding models.
 * @returns {Promise<number[][]>} Resolves to an array of coordinate arrays (embeddings).
 */
async function getEmbeddings(texts, inputType = "passage") {
  if (!NVIDIA_API_KEY) {
    console.warn("[Embedding Service] NVIDIA_API_KEY not configured. Skipping embedding generation.");
    return [];
  }

  const inputArray = Array.isArray(texts) ? texts : [texts];
  if (inputArray.length === 0) return [];

  // Filter out empty/whitespace-only items
  const cleanedInput = inputArray.map(t => String(t || "").trim());

  try {
    const payload = {
      model: NVIDIA_EMBEDDING_MODEL,
      input: cleanedInput,
      input_type: inputType,
      encoding_format: "float"
    };

    const response = await axios.post(`${NVIDIA_BASE_URL}/embeddings`, payload, {
      headers: {
        Authorization: `Bearer ${NVIDIA_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });

    if (response?.data?.data) {
      // Sort elements by index to guarantee correct mapping order
      const sortedData = [...response.data.data].sort((a, b) => (a.index || 0) - (b.index || 0));
      return sortedData.map(item => item.embedding);
    }
    return [];
  } catch (err) {
    const errorMsg = err?.response?.data?.error?.message || err?.response?.data?.message || err?.message;
    console.error(`[Embedding Service] Failed to generate embeddings: ${errorMsg}`);
    return [];
  }
}

module.exports = {
  getEmbeddings,
};
