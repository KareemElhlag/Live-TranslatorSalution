import express from "express";
import cors from "cors";
import path from "path";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadDotEnv(path.join(__dirname, ".env"));

const MODELS_PATH = path.join(__dirname, "models.json");
const MODELS_EXAMPLE_PATH = path.join(__dirname, "models.example.json");
const KEYS_PATH = path.join(__dirname, "keys.json");
const ANTHROPIC_VERSION = "2023-06-01";

const PROVIDER_CONFIG = {
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    envKey: "OPENROUTER_API_KEY",
    supportsVisionDefault: true,
    call: "openai",
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    envKey: "GEMINI_API_KEY",
    supportsVisionDefault: true,
    call: "gemini",
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1/messages",
    envKey: "ANTHROPIC_API_KEY",
    supportsVisionDefault: true,
    call: "anthropic",
  },
  zenmux: {
    baseUrl: "https://zenmux.ai/api/v1/chat/completions",
    envKey: "ZENMUX_API_KEY",
    supportsVisionDefault: false,
    call: "openai",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1/chat/completions",
    envKey: "OPENAI_API_KEY",
    supportsVisionDefault: true,
    call: "openai",
  },
};

const SECRET_SLOTS = [
  {
    envKey: "OPENROUTER_API_KEY",
    label: "OpenRouter",
    hint: "مفتاح واحد → أي موديل Vision/نص من OpenRouter (google/... أو openai/...)",
  },
  {
    envKey: "GEMINI_API_KEY",
    label: "Google Gemini",
    hint: "من Google AI Studio",
  },
  {
    envKey: "ANTHROPIC_API_KEY",
    label: "Anthropic Claude",
    hint: "للموديل المدمج Claude",
  },
  {
    envKey: "ZENMUX_API_KEY",
    label: "ZenMux",
    hint: "لـ GLM المجاني وغيره على ZenMux",
  },
  {
    envKey: "OPENAI_API_KEY",
    label: "OpenAI مباشر",
    hint: "لو هتنادي api.openai.com من غير OpenRouter",
  },
];

const CHEAP_PRESETS = [
  {
    id: "or-gemini-flash",
    name: "OpenRouter · أي Gemini Flash",
    provider: "openrouter",
    model: "google/gemini-3.6-flash",
    supportsVision: true,
    note: "رخيص + Vision — غيّر اسم الموديل لأي slug على OpenRouter",
  },
  {
    id: "or-gpt-4o-mini",
    name: "OpenRouter · GPT-4o mini",
    provider: "openrouter",
    model: "openai/gpt-4o-mini",
    supportsVision: true,
    note: "Vision عبر OpenRouter بنفس المفتاح",
  },
  {
    id: "gemini-flash",
    name: "Gemini 2.0 Flash مباشر",
    provider: "gemini",
    model: "gemini-2.0-flash",
    supportsVision: true,
    note: "رخيص من Google مباشرة",
  },
  {
    id: "zenmux-glm-5.3-free",
    name: "GLM 5.3 Free (ZenMux)",
    provider: "zenmux",
    model: "z-ai/glm-5.3-free",
    supportsVision: false,
    note: "مجاني نصي — مش للكاميرا",
  },
  {
    id: "claude-builtin",
    name: "Claude (مدمج)",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    supportsVision: true,
    note: "أغلى — جودة أعلى وبحث حي",
  },
];

const CUSTOM_PROXY_HOSTS = new Set(
  (process.env.CUSTOM_PROXY_HOSTS ||
    "api.anthropic.com,api.deepseek.com,api.openai.com,api.groq.com,openrouter.ai,api.together.xyz,generativelanguage.googleapis.com,zenmux.ai")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
);

const visionLimiter = createRateLimiter({ windowMs: 10_000, max: 6 });
const searchLimiter = createRateLimiter({ windowMs: 20_000, max: 4 });

ensureModelsFile();

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: true }));
app.use(express.json({ limit: "12mb" }));

function ensureModelsFile() {
  if (existsSync(MODELS_PATH)) return;
  if (existsSync(MODELS_EXAMPLE_PATH)) {
    copyFileSync(MODELS_EXAMPLE_PATH, MODELS_PATH);
    return;
  }
  writeFileSync(
    MODELS_PATH,
    JSON.stringify(
      {
        activeId: "or-gemini-flash",
        models: [
          {
            id: "or-gemini-flash",
            name: "OpenRouter · Gemini Flash",
            provider: "openrouter",
            baseUrl: PROVIDER_CONFIG.openrouter.baseUrl,
            model: "google/gemini-3.6-flash",
            supportsVision: true,
            supportsWebSearch: false,
            envKey: "OPENROUTER_API_KEY",
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );
}

function readKeysFile() {
  if (!existsSync(KEYS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(KEYS_PATH, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeKeysFile(keys) {
  writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2), "utf8");
}

function getSecret(envKey) {
  if (!envKey) return "";
  const fromEnv = process.env[envKey];
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  const fromFile = readKeysFile()[envKey];
  if (fromFile && String(fromFile).trim()) return String(fromFile).trim();
  return "";
}

function readStore() {
  ensureModelsFile();
  try {
    return JSON.parse(readFileSync(MODELS_PATH, "utf8"));
  } catch {
    return { activeId: "", models: [] };
  }
}

function writeStore(store) {
  const cleaned = {
    activeId: store.activeId || "",
    models: (store.models || []).map((m) => normalizeModelEntry(m)),
  };
  writeFileSync(MODELS_PATH, JSON.stringify(cleaned, null, 2), "utf8");
}

function normalizeModelEntry(raw) {
  const provider = PROVIDER_CONFIG[raw.provider]
    ? raw.provider
    : guessProvider(raw);
  const cfg = PROVIDER_CONFIG[provider] || PROVIDER_CONFIG.openai;
  return {
    id: raw.id,
    name: raw.name,
    provider,
    baseUrl: cfg.baseUrl || raw.baseUrl || "",
    model: raw.model || "",
    supportsVision: Boolean(raw.supportsVision),
    supportsWebSearch: provider === "anthropic" ? Boolean(raw.supportsWebSearch) : false,
    envKey: raw.envKey || cfg.envKey,
  };
}

function guessProvider(raw) {
  const base = (raw.baseUrl || "").toLowerCase();
  if (raw.provider === "anthropic" || base.includes("anthropic")) return "anthropic";
  if (raw.provider === "gemini" || base.includes("generativelanguage")) return "gemini";
  if (base.includes("zenmux")) return "zenmux";
  if (base.includes("openrouter")) return "openrouter";
  if (raw.useEnvKey && raw.provider === "openai" && base.includes("openai.com")) return "openai";
  if (PROVIDER_CONFIG[raw.provider]) return raw.provider;
  return "openai";
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function publicModel(m) {
  const entry = normalizeModelEntry(m);
  const key = getSecret(entry.envKey);
  return {
    ...entry,
    hasApiKey: Boolean(key),
    apiKeyMasked: key ? maskKey(key) : `(حط ${entry.envKey})`,
    useEnvKey: true,
  };
}

function getActiveModel(store = readStore()) {
  const models = Array.isArray(store.models) ? store.models : [];
  return models.find((m) => m.id === store.activeId) || models[0] || null;
}

function resolveApiKey(model) {
  const entry = normalizeModelEntry(model);
  return getSecret(entry.envKey);
}

function missingKeyMessage(model) {
  const entry = normalizeModelEntry(model);
  return `${entry.envKey} مش موجود — حطه من الإعدادات أو في .env / Environment Variables`;
}

function extractAnthropicText(data) {
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

async function callAnthropic({ apiKey, model, messages, tools, maxTokens = 1200 }) {
  const body = { model, max_tokens: maxTokens, messages };
  if (tools) body.tools = tools;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Anthropic error ${res.status}`);
  return extractAnthropicText(data);
}

async function callGemini({ apiKey, model, prompt, imageBase64, maxTokens = 1200 }) {
  const modelId = model || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const parts = [{ text: prompt }];
  if (imageBase64) {
    parts.push({ inline_data: { mime_type: "image/jpeg", data: imageBase64 } });
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: maxTokens,
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Gemini error ${res.status}`);
  return (data?.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim();
}

async function callOpenAICompatible({ baseUrl, apiKey, model, prompt, imageBase64, maxTokens = 1200 }) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Base URL غير صالح");
  }
  if (parsed.protocol !== "https:") throw new Error("Base URL لازم يكون HTTPS");
  if (!CUSTOM_PROXY_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(
      `الدومين ${parsed.hostname} مش مسموح. أضف CUSTOM_PROXY_HOSTS لو محتاج موفر تاني.`
    );
  }

  const content = imageBase64
    ? [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
      ]
    : prompt;

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (parsed.hostname.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = process.env.APP_URL || "http://localhost:3001";
    headers["X-Title"] = "Live Translator";
  }

  const body = {
    model,
    messages: [{ role: "user", content }],
    temperature: 0.2,
    max_tokens: maxTokens,
  };

  const r = await fetch(parsed.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `model error ${r.status}`);
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

async function runModel({ imageBase64, prompt, requireVision = false, webSearch = false }) {
  const store = readStore();
  const active = getActiveModel(store);
  if (!active) throw new Error("مفيش موديل محفوظ. افتح الإعدادات وأضف موديل.");

  const entry = normalizeModelEntry(active);
  if (requireVision && !entry.supportsVision) {
    throw new Error(
      `الموديل "${entry.name}" مش بيدعم قراءة الصور. اختار موديل Vision (مثلاً من OpenRouter).`
    );
  }

  const apiKey = resolveApiKey(entry);
  if (!apiKey) throw new Error(missingKeyMessage(entry));

  const cfg = PROVIDER_CONFIG[entry.provider] || PROVIDER_CONFIG.openai;
  const maxTokens = imageBase64 ? 800 : 700;

  if (cfg.call === "anthropic") {
    const messages = imageBase64
      ? [
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
        ]
      : [{ role: "user", content: prompt }];

    const tools =
      webSearch && entry.supportsWebSearch
        ? [{ type: "web_search_20250305", name: "web_search" }]
        : undefined;

    return {
      text: await callAnthropic({
        apiKey,
        model: entry.model || "claude-sonnet-4-6",
        messages,
        tools,
        maxTokens,
      }),
      model: publicModel(entry),
    };
  }

  if (cfg.call === "gemini") {
    return {
      text: await callGemini({
        apiKey,
        model: entry.model || "gemini-2.0-flash",
        prompt,
        imageBase64,
        maxTokens,
      }),
      model: publicModel(entry),
    };
  }

  return {
    text: await callOpenAICompatible({
      baseUrl: entry.baseUrl || cfg.baseUrl,
      apiKey,
      model: entry.model,
      prompt,
      imageBase64,
      maxTokens,
    }),
    model: publicModel(entry),
  };
}

app.get("/api/health", (_req, res) => {
  const active = getActiveModel();
  res.json({
    ok: true,
    hasOpenRouterKey: Boolean(getSecret("OPENROUTER_API_KEY")),
    hasGeminiKey: Boolean(getSecret("GEMINI_API_KEY")),
    hasAnthropicKey: Boolean(getSecret("ANTHROPIC_API_KEY")),
    activeModel: active ? publicModel(active) : null,
  });
});

app.get("/api/keys", (_req, res) => {
  res.json({
    keys: SECRET_SLOTS.map((slot) => {
      const value = getSecret(slot.envKey);
      const fromEnv = Boolean(process.env[slot.envKey]);
      return {
        ...slot,
        set: Boolean(value),
        masked: value ? maskKey(value) : "",
        source: fromEnv ? "env" : value ? "keys.json" : "missing",
      };
    }),
  });
});

app.post("/api/keys", (req, res) => {
  try {
    const body = req.body || {};
    const allowed = new Set(SECRET_SLOTS.map((s) => s.envKey));
    const fileKeys = readKeysFile();
    let updated = 0;

    for (const [envKey, value] of Object.entries(body)) {
      if (!allowed.has(envKey)) continue;
      const trimmed = String(value || "").trim();
      if (!trimmed) continue;
      fileKeys[envKey] = trimmed;
      // خلي الجلسة الحالية تشوفه فورًا لو مفيش env أعلى أولوية
      if (!process.env[envKey]) process.env[envKey] = trimmed;
      updated += 1;
    }

    if (!updated) {
      return res.status(400).json({ error: "مفيش مفتاح صالح اتبعت. اكتب قيمة جديدة للحفظ." });
    }

    writeKeysFile(fileKeys);
    res.json({
      ok: true,
      keys: SECRET_SLOTS.map((slot) => {
        const value = getSecret(slot.envKey);
        const fromEnv = Boolean(process.env[slot.envKey]) && process.env[slot.envKey] !== fileKeys[slot.envKey];
        return {
          ...slot,
          set: Boolean(value),
          masked: value ? maskKey(value) : "",
          source: !value ? "missing" : fromEnv ? "env" : fileKeys[slot.envKey] ? "keys.json" : "env",
        };
      }),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/models/presets", (_req, res) => {
  res.json({
    presets: CHEAP_PRESETS.map((p) => {
      const cfg = PROVIDER_CONFIG[p.provider] || PROVIDER_CONFIG.openai;
      return {
        ...p,
        baseUrl: cfg.baseUrl,
        envKey: cfg.envKey,
        hasEnvKey: Boolean(getSecret(cfg.envKey)),
        supportsWebSearch: p.provider === "anthropic",
      };
    }),
  });
});

app.get("/api/models", (_req, res) => {
  const store = readStore();
  res.json({
    activeId: store.activeId || null,
    models: (store.models || []).map(publicModel),
  });
});

app.post("/api/models/active", (req, res) => {
  const { id } = req.body || {};
  const store = readStore();
  const found = (store.models || []).find((m) => m.id === id);
  if (!found) return res.status(404).json({ error: "الموديل مش موجود" });
  store.activeId = id;
  writeStore(store);
  res.json({ activeId: id, model: publicModel(found) });
});

app.post("/api/models", (req, res) => {
  try {
    const body = req.body || {};
    const store = readStore();
    if (!Array.isArray(store.models)) store.models = [];

    const provider = PROVIDER_CONFIG[body.provider] ? body.provider : "openrouter";
    const cfg = PROVIDER_CONFIG[provider];
    const name = String(body.name || "").trim();
    const model = String(body.model || "").trim();

    if (!name || !model) {
      return res.status(400).json({ error: "الاسم واسم الموديل مطلوبين" });
    }

    // لو المستخدم بعت مفتاح مع الحفظ، خزّنه في keys.json مش في models.json
    if (typeof body.apiKey === "string" && body.apiKey.trim()) {
      const fileKeys = readKeysFile();
      fileKeys[cfg.envKey] = body.apiKey.trim();
      writeKeysFile(fileKeys);
      if (!process.env[cfg.envKey]) process.env[cfg.envKey] = body.apiKey.trim();
    }

    const existing = body.id ? store.models.find((m) => m.id === body.id) : null;
    const id = existing?.id || body.id || randomUUID();

    const entry = normalizeModelEntry({
      id,
      name,
      provider,
      model,
      supportsVision:
        body.supportsVision === undefined ? cfg.supportsVisionDefault : Boolean(body.supportsVision),
      supportsWebSearch: provider === "anthropic" ? Boolean(body.supportsWebSearch ?? true) : false,
      envKey: cfg.envKey,
    });

    if (existing) {
      store.models = store.models.map((m) => (m.id === id ? entry : m));
    } else {
      store.models.push(entry);
    }
    if (!store.activeId) store.activeId = id;
    writeStore(store);
    res.json({ model: publicModel(entry), activeId: store.activeId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/models/:id", (req, res) => {
  const store = readStore();
  const id = req.params.id;
  const before = store.models?.length || 0;
  store.models = (store.models || []).filter((m) => m.id !== id);
  if (store.models.length === before) {
    return res.status(404).json({ error: "الموديل مش موجود" });
  }
  if (store.activeId === id) {
    store.activeId = store.models[0]?.id || "";
  }
  writeStore(store);
  res.json({ ok: true, activeId: store.activeId, models: store.models.map(publicModel) });
});

app.post("/api/vision", visionLimiter, async (req, res) => {
  try {
    const { imageBase64, prompt } = req.body || {};
    if (!imageBase64 || !prompt) {
      return res.status(400).json({ error: "imageBase64 و prompt مطلوبين" });
    }
    const result = await runModel({ imageBase64, prompt, requireVision: true });
    res.json({ text: result.text, model: result.model });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/anthropic-search", searchLimiter, async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "prompt مطلوب" });
    const result = await runModel({ prompt, webSearch: true });
    res.json({ text: result.text, model: result.model });
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
    const text = await callOpenAICompatible({ baseUrl, apiKey, model, prompt, imageBase64 });
    res.json({ text });
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
