import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "12mb" })); // الصور base64 بتبقى تقيلة شوية

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

async function callAnthropic(body) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `Anthropic error ${res.status}`);
  }
  return data;
}

function extractText(data) {
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// خطوة 1: قراءة النص من الصورة + ترجمته
app.post("/api/vision", async (req, res) => {
  try {
    if (!ANTHROPIC_KEY) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY مش متظبط في .env بتاع السيرفر" });
    }
    const { imageBase64, prompt } = req.body;
    if (!imageBase64 || !prompt) {
      return res.status(400).json({ error: "imageBase64 و prompt مطلوبين" });
    }
    const data = await callAnthropic({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } },
            { type: "text", text: prompt },
          ],
        },
      ],
    });
    res.json({ text: extractText(data) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// خطوة 2 (الموديل المدمج): بحث في الإنترنت
app.post("/api/anthropic-search", async (req, res) => {
  try {
    if (!ANTHROPIC_KEY) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY مش متظبط في .env بتاع السيرفر" });
    }
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "prompt مطلوب" });
    const data = await callAnthropic({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    });
    res.json({ text: extractText(data) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// خطوة 2 (موديل مخصص زي DeepSeek): بروكسي عام
app.post("/api/custom-proxy", async (req, res) => {
  try {
    const { baseUrl, apiKey, model, prompt, imageBase64 } = req.body;
    if (!baseUrl || !apiKey || !model || !prompt) {
      return res.status(400).json({ error: "baseUrl / apiKey / model / prompt مطلوبين" });
    }
    const content = imageBase64
      ? [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
        ]
      : prompt;

    const r = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content }] }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || `custom model error ${r.status}`);
    res.json({ text: data?.choices?.[0]?.message?.content?.trim() || "" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// تقديم ملفات الفرونت إند من مجلد public
app.use(express.static(path.join(__dirname, "public")));

// حل مشكلة Cannot GET / بعرض ملف index.html الرئيسي
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`proxy server running on :${PORT}`));