import base64
import io
import os

from flask import Flask, jsonify, request, send_file

try:
    import torch
    from diffusers import DiffusionPipeline
except Exception as exc:  # pragma: no cover
    torch = None
    DiffusionPipeline = None
    IMPORT_ERROR = str(exc)
else:
    IMPORT_ERROR = None


MODEL_ID = os.getenv("LOCAL_IMAGE_MODEL_ID", "aiyouthalliance/Free-Image-Generation")
HOST = os.getenv("LOCAL_IMAGE_WORKER_HOST", "127.0.0.1")
PORT = int(os.getenv("LOCAL_IMAGE_WORKER_PORT", "8001"))
API_KEY = os.getenv("LOCAL_IMAGE_WORKER_API_KEY", "").strip()
RETURN_MODE = os.getenv("LOCAL_IMAGE_WORKER_RETURN_MODE", "json_base64").strip().lower()

app = Flask(__name__)
pipe = None


def require_auth():
    if not API_KEY:
        return None
    auth_header = request.headers.get("Authorization", "")
    expected = f"Bearer {API_KEY}"
    if auth_header != expected:
        return jsonify({"error": "Unauthorized"}), 401
    return None


def load_pipeline():
    global pipe
    if pipe is not None:
        return pipe
    if IMPORT_ERROR:
        raise RuntimeError(f"Image worker dependencies unavailable: {IMPORT_ERROR}")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32
    pipe = DiffusionPipeline.from_pretrained(MODEL_ID, torch_dtype=dtype)
    pipe = pipe.to(device)
    return pipe


@app.get("/health")
def health():
    return jsonify({
        "ok": True,
        "model_id": MODEL_ID,
        "dependencies_ready": IMPORT_ERROR is None,
        "device": "cuda" if (torch and torch.cuda.is_available()) else "cpu",
    })


@app.post("/generate-image")
def generate_image():
    auth_error = require_auth()
    if auth_error:
        return auth_error

    try:
        payload = request.get_json(force=True) or {}
        prompt = str(payload.get("prompt", "")).strip()
        if not prompt:
            return jsonify({"error": "prompt is required"}), 400

        negative_prompt = str(payload.get("negative_prompt", "")).strip() or None
        width = int(payload.get("width", 1024))
        height = int(payload.get("height", 1024))
        steps = int(payload.get("num_inference_steps", 30))
        guidance = float(payload.get("guidance_scale", 7.5))
        output_format = str(payload.get("output_format", "png")).lower()

        generator = load_pipeline()
        image = generator(
            prompt=prompt,
            negative_prompt=negative_prompt,
            width=width,
            height=height,
            num_inference_steps=steps,
            guidance_scale=guidance,
        ).images[0]

        mime = "image/png" if output_format != "jpeg" else "image/jpeg"
        pil_format = "PNG" if output_format != "jpeg" else "JPEG"
        buffer = io.BytesIO()
        image.save(buffer, format=pil_format)
        buffer.seek(0)

        if RETURN_MODE == "binary":
            return send_file(buffer, mimetype=mime)

        return jsonify({
            "mime_type": mime,
            "image_base64": base64.b64encode(buffer.read()).decode("utf-8"),
            "model_id": MODEL_ID,
        })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


if __name__ == "__main__":
    app.run(host=HOST, port=PORT)
