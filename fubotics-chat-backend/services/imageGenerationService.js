function createImageGenerationService({
  axios,
  fs,
  path,
  attachmentModel,
  generatedDir,
  buildGeneratedFilename,
  createFallbackPng,
  sambaNovaApiKey,
  sambaNovaBaseUrl,
  sambaNovaPromptModel,
  nvidiaApiKey,
  nvidiaBaseUrl,
  nvidiaImageModel,
  freepikApiKey,
  freepikImageModel,
  freepikPollAttempts,
  freepikPollIntervalMs,
  huggingFaceApiKey,
  huggingFaceImageModel,
  pollinationsBaseUrl,
  pollinationsImageModel,
  localImageWorkerUrl,
  localImageWorkerApiKey,
  localImageWorkerTimeoutMs,
  allowPlaceholderFallback,
}) {
  async function buildImagePromptWithNVIDIA(userPrompt) {
    if (!nvidiaApiKey) {
      return userPrompt;
    }
    try {
      const resp = await axios.post(
        `${nvidiaBaseUrl}/chat/completions`,
        {
          model: nvidiaImageModel, // Using Qwen image model for prompt enhancement
          temperature: 0.4,
          max_tokens: 500,
          messages: [
            {
              role: "system",
              content: "You are an expert prompt engineer for text-to-image models. Return one detailed visual prompt only.",
            },
            {
              role: "user",
              content: `Create a production-grade text-to-image prompt for: ${userPrompt}`,
            },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${nvidiaApiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 60000,
        }
      );
      return resp.data?.choices?.[0]?.message?.content?.trim() || userPrompt;
    } catch (err) {
      console.error("NVIDIA prompt generation failed, using raw prompt:", err.message);
      return userPrompt;
    }
  }

  async function generateImageWithFreepik(textPrompt) {
    const baseUrl =
      freepikImageModel === "mystic"
        ? "https://api.freepik.com/v1/ai/mystic"
        : `https://api.freepik.com/v1/ai/text-to-image/${encodeURIComponent(freepikImageModel)}`;
    const createRes = await axios.post(
      baseUrl,
      {
        prompt: textPrompt,
        aspect_ratio: "square_1_1",
        output_format: "png",
      },
      {
        headers: {
          "x-freepik-api-key": freepikApiKey,
          "Content-Type": "application/json",
        },
        timeout: 60000,
        validateStatus: () => true,
      }
    );

    if (createRes.status >= 400) {
      throw new Error(`Freepik create task failed (${createRes.status}): ${JSON.stringify(createRes.data).slice(0, 260)}`);
    }

    const taskId = createRes.data?.data?.task_id;
    if (!taskId) {
      throw new Error("Freepik did not return task_id");
    }

    for (let i = 0; i < freepikPollAttempts; i++) {
      const pollRes = await axios.get(`${baseUrl}/${taskId}`, {
        headers: {
          "x-freepik-api-key": freepikApiKey,
        },
        timeout: 45000,
        validateStatus: () => true,
      });

      if (pollRes.status >= 400) {
        throw new Error(`Freepik poll failed (${pollRes.status}): ${JSON.stringify(pollRes.data).slice(0, 260)}`);
      }

      const payload = pollRes.data?.data || {};
      const generated = Array.isArray(payload.generated) ? payload.generated : [];
      if (generated.length > 0 && generated[0]) {
        const imageUrl = generated[0];
        const imageRes = await axios.get(imageUrl, {
          responseType: "arraybuffer",
          timeout: 60000,
          validateStatus: () => true,
        });
        if (imageRes.status >= 400) {
          throw new Error(`Freepik image download failed (${imageRes.status})`);
        }
        const contentType = imageRes.headers["content-type"] || "image/png";
        return { buffer: Buffer.from(imageRes.data), mime: contentType };
      }

      const status = String(payload.status || "").toUpperCase();
      if (status === "FAILED" || status === "REJECTED" || status === "CANCELLED") {
        throw new Error(`Freepik task ended with status ${status}`);
      }

      await new Promise((resolve) => setTimeout(resolve, freepikPollIntervalMs));
    }

    throw new Error("Freepik task timed out");
  }

  async function generateImageWithLocalWorker(textPrompt) {
    if (!localImageWorkerUrl) {
      throw new Error("LOCAL_IMAGE_WORKER_URL is not configured");
    }
    const payload = {
      prompt: textPrompt,
      width: 1024,
      height: 1024,
      num_inference_steps: 30,
      guidance_scale: 7.5,
      output_format: "png",
    };
    const headers = { "Content-Type": "application/json" };
    if (localImageWorkerApiKey) {
      headers.Authorization = `Bearer ${localImageWorkerApiKey}`;
    }
    const response = await axios.post(localImageWorkerUrl, payload, {
      headers,
      timeout: localImageWorkerTimeoutMs,
      validateStatus: () => true,
    });

    const contentType = String(response.headers["content-type"] || "").toLowerCase();
    if (contentType.startsWith("image/")) {
      return { buffer: Buffer.from(response.data), mime: contentType };
    }

    if (response.status >= 400) {
      throw new Error(`Local image worker failed (${response.status}): ${JSON.stringify(response.data).slice(0, 260)}`);
    }

    const data = response.data || {};
    if (data.image_base64) {
      const mime = data.mime_type || "image/png";
      return { buffer: Buffer.from(data.image_base64, "base64"), mime };
    }
    if (data.image_url) {
      const imageRes = await axios.get(data.image_url, {
        responseType: "arraybuffer",
        timeout: localImageWorkerTimeoutMs,
        validateStatus: () => true,
      });
      if (imageRes.status >= 400) {
        throw new Error(`Local image worker returned image_url but download failed (${imageRes.status})`);
      }
      return {
        buffer: Buffer.from(imageRes.data),
        mime: imageRes.headers["content-type"] || "image/png",
      };
    }

    throw new Error("Local image worker returned no image payload");
  }

  async function generateImageFile(sessionId, prompt) {
    let imageBuffer = null;
    let imageMime = "image/png";
    let providerUsed = null;
    const promptForGenerator = await buildImagePromptWithNVIDIA(prompt);

    if (!imageBuffer && localImageWorkerUrl) {
      try {
        const workerImage = await generateImageWithLocalWorker(promptForGenerator);
        imageBuffer = workerImage.buffer;
        imageMime = workerImage.mime;
        providerUsed = "local_text_to_image_worker";
        console.warn("Image generation used local text-to-image worker.");
      } catch (err) {
        console.error("Local text-to-image worker failed:", err.message);
      }
    }

    if (!imageBuffer && freepikApiKey) {
      try {
        const freepikImage = await generateImageWithFreepik(promptForGenerator);
        imageBuffer = freepikImage.buffer;
        imageMime = freepikImage.mime;
        providerUsed = "freepik";
        console.warn("Image generation used Freepik provider.");
      } catch (err) {
        console.error("Freepik image generation failed:", err.message);
      }
    }

    if (!imageBuffer && huggingFaceApiKey) {
      let lastError = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const hfRes = await axios.post(
            `https://router.huggingface.co/hf-inference/models/${encodeURIComponent(huggingFaceImageModel)}`,
            { inputs: promptForGenerator },
            {
              headers: {
                Authorization: `Bearer ${huggingFaceApiKey}`,
                "Content-Type": "application/json",
                Accept: "image/png",
              },
              responseType: "arraybuffer",
              timeout: 90000,
              validateStatus: () => true,
            }
          );

          const contentType = hfRes.headers["content-type"] || "";
          if (contentType.startsWith("image/")) {
            imageBuffer = Buffer.from(hfRes.data);
            imageMime = contentType;
            providerUsed = "huggingface";
            break;
          }

          const bodyText = Buffer.from(hfRes.data).toString("utf8");
          let payload = {};
          try {
            payload = JSON.parse(bodyText);
          } catch (_) {
            payload = { error: bodyText.substring(0, 300) };
          }

          if (payload?.estimated_time) {
            await new Promise((resolve) => setTimeout(resolve, Math.ceil(payload.estimated_time * 1000)));
            continue;
          }
          throw new Error(payload?.error || payload?.message || `Hugging Face request failed with status ${hfRes.status}`);
        } catch (err) {
          lastError = err;
        }
      }
      if (!imageBuffer && lastError) {
        console.error("Hugging Face image generation failed:", lastError.message);
      }
    }

    if (!imageBuffer && pollinationsBaseUrl) {
      try {
        const pollinationsUrl = `${pollinationsBaseUrl}/prompt/${encodeURIComponent(promptForGenerator)}?model=${encodeURIComponent(pollinationsImageModel)}&width=1024&height=1024&nologo=true`;
        const pollinationsRes = await axios.get(pollinationsUrl, {
          responseType: "arraybuffer",
          timeout: 90000,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          },
        });
        imageBuffer = Buffer.from(pollinationsRes.data);
        imageMime = pollinationsRes.headers["content-type"] || "image/png";
        providerUsed = "pollinations";
        console.warn("Image generation used Pollinations fallback provider.");
      } catch (err) {
        console.error("Pollinations fallback failed:", err.message);
      }
    }

    if (!imageBuffer) {
      if (!allowPlaceholderFallback) {
        throw new Error(
          "No real text-to-image provider succeeded. Configure LOCAL_IMAGE_WORKER_URL, FREEPIK_API_KEY, HUGGINGFACE_API_KEY, or POLLINATIONS_BASE_URL."
        );
      }
      imageBuffer = createFallbackPng(prompt);
      imageMime = "image/png";
      providerUsed = "placeholder_fallback";
      console.warn("All image providers failed. Served local PNG placeholder fallback.");
    }

    const ext = imageMime.includes("jpeg")
      ? "jpg"
      : imageMime.includes("webp")
      ? "webp"
      : "png";
    const filename = buildGeneratedFilename(prompt, "image", ext);
    const filePath = path.join(generatedDir, filename);
    fs.writeFileSync(filePath, imageBuffer);
    return attachmentModel.create(
      sessionId,
      filename,
      filename,
      filePath,
      imageMime,
      fs.statSync(filePath).size,
      JSON.stringify({ type: "generated_image", prompt, prompt_for_generator: promptForGenerator, provider: providerUsed }),
      true
    );
  }

  return {
    buildImagePromptWithNVIDIA,
    generateImageFile,
  };
}

module.exports = {
  createImageGenerationService,
};
