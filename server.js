import express from "express";
import cors from "cors";
import path from "path";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadDotEnv(path.join(__dirname, ".env"));

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: true }));
app.use(express.json({ limit: "12mb" }));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const CUSTOM_PROXY_HOSTS = new Set(
  (process.env.CUSTOM_PROXY_HOSTS ||
    "api.deepseek.com,api.openai.com,api.groq.com,openrouter.ai,api.together.xyz,generativelanguage.googleapis.com")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
);

const visionLimiter = createRateLimiter({ windowMs: 10_000, max: 6 });
const searchLimiter = createRateLimiter({ windowMs: 20_000, max: 4 });

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
  const data = await res.json().catch(() => ({}));
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

function requireAnthropicKey(req, res, next) {
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({
      error: "ANTHROPIC_API_KEY مش متظبط. حطه في Environment Variables على منصة الاستضافة أو في ملف .env محليًا.",
    });
  }
  next();
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasAnthropicKey: Boolean(ANTHROPIC_KEY),
    model: ANTHROPIC_MODEL,
  });
});

app.post("/api/vision", requireAnthropicKey, visionLimiter, async (req, res) => {
  try {
    const { imageBase64, prompt } = req.body || {};
    if (!imageBase64 || !prompt) {
      return res.status(400).json({ error: "imageBase64 و prompt مطلوبين" });
    }
    const data = await callAnthropic({
      model: ANTHROPIC_MODEL,
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: imageBase64 },
            },
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

app.post("/api/anthropic-search", requireAnthropicKey, searchLimiter, async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "prompt مطلوب" });
    const data = await callAnthropic({
      model: ANTHROPIC_MODEL,
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    });
    res.json({ text: extractText(data) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/custom-proxy", searchLimiter, async (req, res) => {
  try {
    const { baseUrl, apiKey, model, prompt, imageBase64 } = req.body || {};
    if (!baseUrl || !apiKey || !model || !prompt) {
      return res.status(400).json({ error: "baseUrl / apiKey / model / prompt مطلوبين" });
    }

    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      return res.status(400).json({ error: "Base URL غير صالح" });
    }
    if (parsed.protocol !== "https:") {
      return res.status(400).json({ error: "Base URL لازم يكون HTTPS" });
    }
    if (!CUSTOM_PROXY_HOSTS.has(parsed.hostname.toLowerCase())) {
      return res.status(400).json({
        error: `الدومين ${parsed.hostname} مش مسموح. أضف CUSTOM_PROXY_HOSTS لو محتاج موفر تاني.`,
      });
    }

    const content = imageBase64
      ? [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
        ]
      : prompt;

    const r = await fetch(parsed.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content }] }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error?.message || `custom model error ${r.status}`);
    res.json({ text: data?.choices?.[0]?.message?.content?.trim() || "" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const distDir = path.join(__dirname, "dist");
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    res.sendFile(path.join(distDir, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res
      .status(200)
      .send("API شغال. شغّل الفرونت بـ npm run dev، أو ابنِه بـ npm run build قبل start في الإنتاج.");
  });
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`live-translator listening on :${PORT}`);
});

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return function rateLimit(req, res, next) {
    const ip = req.ip || req.headers["x-forwarded-for"] || "local";
    const now = Date.now();
    const bucket = hits.get(ip) || [];
    const recent = bucket.filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      return res.status(429).json({ error: "طلبات كتير في وقت قصير، استنى ثانية وجرب تاني." });
    }
    recent.push(now);
    hits.set(ip, recent);
    next();
  };
}
