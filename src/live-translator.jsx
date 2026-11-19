import React, { useRef, useState, useEffect, useCallback } from "react";
import {
  Camera,
  Loader2,
  Pause,
  RotateCcw,
  AlertCircle,
  Search,
  Settings,
  X,
  Info,
  Plus,
  Trash2,
  Check,
  Copy,
  Bug,
  RectangleHorizontal,
  RectangleVertical,
} from "lucide-react";

const PROVIDER_DEFAULTS = {
  openrouter: {
    supportsVision: true,
    model: "google/gemini-3.6-flash",
    nameHint: "OpenRouter · موديل جديد",
    modelPlaceholder: "google/gemini-3.6-flash أو openai/gpt-4o-mini أو أي slug",
  },
  gemini: {
    supportsVision: true,
    model: "gemini-2.0-flash",
    nameHint: "Gemini مباشر",
    modelPlaceholder: "gemini-2.0-flash",
  },
  anthropic: {
    supportsVision: true,
    model: "claude-sonnet-4-6",
    nameHint: "Claude",
    modelPlaceholder: "claude-sonnet-4-6",
  },
  zenmux: {
    supportsVision: false,
    model: "z-ai/glm-5.3-free",
    nameHint: "ZenMux",
    modelPlaceholder: "z-ai/glm-5.3-free",
  },
  openai: {
    supportsVision: true,
    model: "gpt-4o-mini",
    nameHint: "OpenAI مباشر",
    modelPlaceholder: "gpt-4o-mini",
  },
};

const EMPTY_DRAFT = {
  id: "",
  name: "OpenRouter · موديل جديد",
  provider: "openrouter",
  model: "",
  supportsVision: true,
};

const MAX_ERROR_LOG = 40;

const SESSION_KEYS_STORAGE_KEY = "live-translator-session-keys";

const DEFAULT_KEY_SLOTS = [
  {
    envKey: "OPENROUTER_API_KEY",
    label: "OpenRouter",
    set: false,
    masked: "",
    source: "missing",
    hint: "بيتخزن في المتصفح (sessionStorage) وبيتبعت مباشرة لـ OpenRouter من غير سيرفر.",
  },
  {
    envKey: "GEMINI_API_KEY",
    label: "Google Gemini",
    set: false,
    masked: "",
    source: "missing",
    hint: "مطلوب لو الموديل المتفعّل من نوع Gemini.",
  },
  {
    envKey: "OPENAI_API_KEY",
    label: "OpenAI",
    set: false,
    masked: "",
    source: "missing",
    hint: "مطلوب لو الموديل المتفعّل من نوع OpenAI.",
  },
  {
    envKey: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    set: false,
    masked: "",
    source: "missing",
    hint: "مطلوب لو الموديل المتفعّل من نوع Claude.",
  },
  {
    envKey: "ZENMUX_API_KEY",
    label: "ZenMux",
    set: false,
    masked: "",
    source: "missing",
    hint: "مطلوب لو الموديل المتفعّل من نوع ZenMux.",
  },
];

/** موديل OpenRouter الاحتياطي لما الـ /api/models مش موجود (استضافة static) */
const SESSION_OPENROUTER_MODEL = {
  id: "session-openrouter",
  name: "OpenRouter · من المتصفح",
  provider: "openrouter",
  model: "google/gemini-3.6-flash",
  supportsVision: true,
  hasApiKey: false,
};

function readSessionKeys() {
  try {
    if (typeof window === "undefined" || !window.sessionStorage) return {};
    const raw = window.sessionStorage.getItem(SESSION_KEYS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeSessionKeys(keys) {
  if (typeof window === "undefined" || !window.sessionStorage) {
    throw new Error(
      "sessionStorage مش متاح في المتصفح — المفتاح مش هيتحفظ بعد إغلاق التاب."
    );
  }

  try {
    window.sessionStorage.setItem(
      SESSION_KEYS_STORAGE_KEY,
      JSON.stringify(keys || {})
    );
  } catch (e) {
    throw new Error(`فشل حفظ المفتاح في sessionStorage: ${e?.message || e}`);
  }
}

function maskApiKey(value) {
  const key = String(value || "").trim();
  if (!key) return "";
  if (key.length <= 8) return `${key.slice(0, 2)}…${key.slice(-2)}`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function mergeKeySlots(serverSlots, sessionKeys) {
  const byEnv = new Map();
  for (const slot of DEFAULT_KEY_SLOTS) byEnv.set(slot.envKey, { ...slot });

  for (const slot of serverSlots || []) {
    if (!slot?.envKey) continue;
    byEnv.set(slot.envKey, { ...(byEnv.get(slot.envKey) || {}), ...slot });
  }

  for (const [envKey, value] of Object.entries(sessionKeys || {})) {
    const trimmed = String(value || "").trim();
    if (!trimmed) continue;
    const base = byEnv.get(envKey) || { envKey, label: envKey, hint: "" };
    byEnv.set(envKey, {
      ...base,
      set: true,
      masked: maskApiKey(trimmed),
      source: "session",
    });
  }

  return Array.from(byEnv.values());
}

async function callOpenRouterDirect({ apiKey, modelId, messages }) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: modelId, messages }),
  });

  const data = await readJsonResponse(response, "OpenRouter");
  if (!response.ok) {
    const detail = data?.error?.message || data?.error;
    throw new Error(
      (typeof detail === "string" && detail) || `OpenRouter HTTP ${response.status}`
    );
  }

  const content = data?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("")
      .trim();
  }
  return String(content || "").trim();
}

const VISION_PROMPT = `You are a careful OCR extractor and Arabic translator for a live camera.
Read the single most prominent English or Russian text near the image center.
If it is a multiple-choice question, include the question and all visible options in "original".
Return only one complete line of valid JSON, with no markdown or extra text:
{"found":true,"original":"<exact source text including all visible options>","translation":"<short, clear Arabic translation>"}
Rules:
- The translation must be concise Modern Standard Arabic only.
- Do not answer questions in the translation field.
- Do not add greetings, fillers, explanations, or markdown.
- Close all quotes and braces.
If nothing readable is present, return: {"found":false}`;

function looksLikeQuestion(original, translatedArabic) {
  const src = (original || "").trim();
  const ar = (translatedArabic || "").trim();
  if (!src && !ar) return false;
  if (/[?؟]\s*$/.test(src) || /[?؟]\s*$/.test(ar)) return true;
  const starters =
    /^(what|why|how|where|when|who|which|is|are|do|does|did|can|could|will|would|что|как|почему|где|когда|кто|какой|можно ли)\b/i;
  return starters.test(src);
}

function looksLikeMultipleChoice(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (/اختر|choose\b|multiple\s*choice|select\s*(one|the\s*correct)/i.test(t)) return true;
  if (/(?:^|\n)\s*(?:[1-4]|[A-Da-d]|[أ-د])[)\]\-.:]\s+\S+/m.test(t)) return true;
  if (/(?:^|\n)\s*(?:[1-4]|[A-Da-d])\s*[)\]\-.:]\s+\S+/m.test(t)) return true;
  const optionHits = t.match(/(?:^|\s)(?:[1-4]|[A-Da-d]|[أ-د])[)\]\-.:]/g);
  return Boolean(optionHits && optionHits.length >= 2);
}

function buildAnswerPrompt(q, translationHint) {
  const isMcq =
    looksLikeMultipleChoice(q) ||
    looksLikeMultipleChoice(translationHint);

  const context = translationHint
    ? `\nArabic OCR/translation context:\n${translationHint}\n`
    : "";

  if (isMcq) {
    return `Answer this multiple-choice question in English.

Question and visible choices:
${q}
${context}
Rules:
- Determine the correct answer using the visible choices.
- The first line must be exactly: "Correct Answer: <exact option label>) <exact choice text>"
- Put the correct answer first and add no introduction.
- If useful, add one concise line beginning "Reason:".
- Do not list the other options or use markdown.
- If the available text is insufficient, say so plainly in English; do not guess.`;
  }

  if (looksLikeQuestion(q, translationHint)) {
    return `Answer this question in English:
${q}
${context}
Rules:
- Give the direct answer first without a greeting or repeated question.
- If the answer requires multiple steps, use only numbered steps: 1., 2., 3., and so on.
- Keep each step concise and readable on a mobile screen.
- If no steps are needed, answer in one or two concise sentences.
- Do not use markdown headings, bullets, or code fences.`;
  }

  return `Translate or briefly summarize this captured text in concise English:
${q}
${context}
Rules:
- Return only the English translation or a very brief English summary.
- Do not add greetings, filler, explanations, or repeated source text.
- Do not use markdown, headings, bullets, or code fences.`;
}

function renderFormattedAnswer(answer) {
  const text = String(answer || "").trim();
  if (!text) return null;

  const choiceMatch = text.match(
    /^Correct Answer:\s*(.+?)(?:\r?\n|$)([\s\S]*)$/i
  );

  if (choiceMatch) {
    const choice = choiceMatch[1].trim();
    const explanation = choiceMatch[2]
      .replace(/^\s*Reason:\s*/i, "")
      .trim();

    return (
      <div dir="ltr" className="space-y-2 text-left">
        <p className="rounded-lg border border-emerald-400/40 bg-emerald-500/15 px-3 py-2 text-base font-bold text-emerald-200">
          Correct Answer: {choice}
        </p>
        {explanation && (
          <p className="text-sm leading-relaxed text-emerald-100/90">
            {explanation}
          </p>
        )}
      </div>
    );
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const steps = lines.map((line) => line.match(/^\d+\.\s+(.+)$/));

  if (lines.length > 0 && steps.every(Boolean)) {
    return (
      <ol
        dir="ltr"
        className="list-decimal space-y-2 pl-6 text-left text-sm leading-relaxed text-emerald-100/95"
      >
        {steps.map((step, index) => (
          <li key={`${index}-${step[1]}`}>{step[1]}</li>
        ))}
      </ol>
    );
  }

  return (
    <p
      dir="ltr"
      className="whitespace-pre-line text-left text-sm leading-relaxed text-emerald-100/95"
    >
      {text}
    </p>
  );
}

function normalizeCapture(parsed) {
  if (!parsed?.found) return [];
  if (Array.isArray(parsed.items) && parsed.items.length) {
    const item = parsed.items[0];
    const original = String(item?.original || "").trim();
    const translation = String(item?.translation || "").trim();
    if (!original && !translation) return [];
    return [{ original, translation }];
  }
  const original = String(parsed.original || "").trim();
  const translation = String(parsed.translation || "").trim();
  if (!original && !translation) return [];
  return [{ original, translation }];
}

function repairTruncatedJson(text) {
  let s = (text || "").trim();
  if (!s.startsWith("{")) return s;

  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
  }
  if (inString) s += '"';

  const opens = (s.match(/\{/g) || []).length;
  const closes = (s.match(/\}/g) || []).length;
  if (opens > closes) s += "}".repeat(opens - closes);
  return s;
}

function extractCaptureFallback(text) {
  const originalMatch = text.match(/"original"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!originalMatch) return null;

  let translation = "";
  const closedTrans = text.match(/"translation"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (closedTrans) {
    translation = closedTrans[1];
  } else {
    const openTrans = text.match(/"translation"\s*:\s*"([\s\S]*)$/);
    if (openTrans) translation = openTrans[1].replace(/["}\s]+$/g, "").trim();
  }

  const unescape = (v) => {
    try {
      return JSON.parse(`"${v}"`);
    } catch {
      return v;
    }
  };

  return {
    found: true,
    original: unescape(originalMatch[1]),
    translation: unescape(translation),
  };
}

function parseModelJson(rawText) {
  const clean = (rawText || "").replace(/```json|```/gi, "").replace(/```/g, "").trim();
  if (!clean) throw new Error("الموديل رجّع رد فاضي");

  const tryParse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  let parsed = tryParse(clean);
  if (parsed) return parsed;

  const repaired = repairTruncatedJson(clean);
  parsed = tryParse(repaired);
  if (parsed) return parsed;

  const match = repaired.match(/\{[\s\S]*\}/);
  if (match) {
    parsed = tryParse(match[0]) || tryParse(repairTruncatedJson(match[0]));
    if (parsed) return parsed;
  }

  const fallback = extractCaptureFallback(clean);
  if (fallback?.original) return fallback;

  const preview = clean.slice(0, 180).replace(/\s+/g, " ");
  throw new Error(`الموديل رجّع رد مش JSON. preview="${preview}"`);
}

async function readJsonResponse(response, label = "") {
  const raw = await response.text();
  const trimmed = (raw || "").trim();
  const endpoint = label || response.url || "/api";
  const contentType = (response.headers?.get?.("content-type") || "").toLowerCase();
  const looksLikeHtml =
    trimmed.startsWith("<") ||
    trimmed.startsWith("<!") ||
    contentType.includes("text/html");

  if (!trimmed) {
    throw new Error(
      response.ok
        ? `رد فاضي من ${endpoint}`
        : `مفيش رد من ${endpoint} (HTTP ${response.status}) — الـ API غير متاح هنا`
    );
  }

  if (looksLikeHtml) {
    throw new Error(
      `الطلب على ${endpoint} رجّع صفحة HTML بدل JSON (HTTP ${response.status}). الـ API غير متاح على الاستضافة الحالية — استخدم مفتاح المزوّد المباشر من الإعدادات.`
    );
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(
      response.ok
        ? `رد مش مفهوم من ${endpoint}: ${trimmed.slice(0, 80)}`
        : trimmed.slice(0, 160) || `${endpoint} error ${response.status}`
    );
  }
}

function formatErrorTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString("ar-EG", { hour12: false });
  } catch {
    return String(ts);
  }
}

/** بصمة بكسل دقيقة لإطار مصغّر — تطابق 100% = نفس الصورة حرفيًا */
function fingerprintVideoFrame(video, canvas) {
  if (!video?.videoWidth || !canvas) return "";
  const w = 160;
  const h = 90;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return "";
  ctx.drawImage(video, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i];
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function normalizeTextKey(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

export default function LiveTranslator() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const intervalRef = useRef(null);
  const busyRef = useRef(false);
  const searchingRef = useRef(false);
  const lastCaptureKeyRef = useRef("");
  const lastSearchKeyRef = useRef("");
  const lastImageHashRef = useRef("");
  const lastRequestAtRef = useRef(0);
  const intervalMsRef = useRef(20000);
  const searchDelayRef = useRef(null);
  const searchRequestIdRef = useRef(0);
  const captureSeqRef = useRef(0);
  const runningRef = useRef(false);

  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState([]);
  const [interval_, setInterval_] = useState(20000);
  const [facing, setFacing] = useState("environment");
  const [searching, setSearching] = useState(false);
  const [searchInfo, setSearchInfo] = useState("");
  const [searchError, setSearchError] = useState("");
  const [errorLog, setErrorLog] = useState([]);
  const [showErrors, setShowErrors] = useState(false);
  const [copyOk, setCopyOk] = useState("");
  const [wideBox, setWideBox] = useState(false);

  const [showSettings, setShowSettings] = useState(false);
  const [models, setModels] = useState([]);
  const [presets, setPresets] = useState([]);
  const [keySlots, setKeySlots] = useState(DEFAULT_KEY_SLOTS);
  const [keyDrafts, setKeyDrafts] = useState({});
  const [sessionKeys, setSessionKeys] = useState(readSessionKeys);
  const [activeId, setActiveId] = useState("");
  const [modelsLoading, setModelsLoading] = useState(true);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [settingsOk, setSettingsOk] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);

  const activeModel =
    models.find((m) => m.id === activeId) ||
    models[0] ||
    (String(sessionKeys.OPENROUTER_API_KEY || "").trim()
      ? SESSION_OPENROUTER_MODEL
      : null);
  const primaryLine = lines[0] || null;

  useEffect(() => {
    intervalMsRef.current = interval_;
  }, [interval_]);

  const pushError = useCallback((source, message, detail = "") => {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: Date.now(),
      source,
      message: String(message || "unknown error"),
      detail: String(detail || ""),
    };
    setErrorLog((prev) => [entry, ...prev].slice(0, MAX_ERROR_LOG));
  }, []);

  const formatErrorLogText = useCallback((entries = errorLog) => {
    return entries
      .map((e) => {
        const head = `[${formatErrorTime(e.ts)}] ${e.source}: ${e.message}`;
        return e.detail ? `${head}\n  detail: ${e.detail}` : head;
      })
      .join("\n\n");
  }, [errorLog]);

  const copyText = useCallback(async (text, okMsg = "تم النسخ") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyOk(okMsg);
      setTimeout(() => setCopyOk(""), 2000);
    } catch {
      pushError("clipboard", "المتصفح منع النسخ — انسخ يدوي من القائمة");
    }
  }, [pushError]);

  const refreshModels = useCallback(async () => {
    setModelsLoading(true);
    setSettingsError("");

    // كل مسار لوحده: فشل /api/models مش بيمنع المفاتيح ولا الموديل الاحتياطي
    try {
      const modelsRes = await fetch("/api/models");
      if (modelsRes.ok) {
        const data = await readJsonResponse(modelsRes, "/api/models");
        setModels(Array.isArray(data.models) ? data.models : []);
        setActiveId(data.activeId || data.models?.[0]?.id || "");
      } else {
        setModels([]);
        setActiveId("");
      }
    } catch (e) {
      setModels([]);
      setActiveId("");
      pushError("models", e.message);
    }

    try {
      const presetsRes = await fetch("/api/models/presets");
      if (presetsRes.ok) {
        const presetData = await readJsonResponse(
          presetsRes,
          "/api/models/presets"
        );
        setPresets(presetData.presets || []);
      } else {
        setPresets([]);
      }
    } catch (e) {
      pushError("presets", e.message);
      setPresets([]);
    }

    try {
      const keysRes = await fetch("/api/keys");
      if (keysRes.ok) {
        const keysData = await readJsonResponse(keysRes, "/api/keys");
        setKeySlots(mergeKeySlots(keysData.keys || [], sessionKeys));
      } else {
        setKeySlots(mergeKeySlots([], sessionKeys));
      }
    } catch (e) {
      pushError("keys", e.message);
      setKeySlots(mergeKeySlots([], sessionKeys));
    } finally {
      setModelsLoading(false);
    }
  }, [pushError, sessionKeys]);

  useEffect(() => {
    refreshModels();
  }, [refreshModels]);

const startCamera = useCallback(async (preferredFacing = facing) => {
    try {
      if (
        typeof window === "undefined" ||
        !window.isSecureContext ||
        !navigator.mediaDevices?.getUserMedia
      ) {
        const message =
          "يتطلب تشغيل الكاميرا اتصالاً آمناً عبر HTTPS أو localhost.";
        pushError("camera", message);
        window.alert(message);
        return;
      }

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: {
            ideal: preferredFacing,
          },
        },
        audio: false,
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch (error) {
      let message = "تعذر تشغيل الكاميرا.";

      if (error?.name === "NotAllowedError") {
        message =
          "تم رفض إذن الكاميرا. اسمح للمتصفح بالوصول إلى الكاميرا، ثم حاول مرة أخرى.";
      } else if (error?.name === "NotFoundError") {
        message = "لم يتم العثور على كاميرا متاحة على هذا الجهاز.";
      } else if (error?.name === "NotReadableError") {
        message = "تعذر الوصول إلى الكاميرا. قد تكون مستخدمة من تطبيق آخر.";
      }

      pushError("camera", message, error?.message || error?.name || "");
      window.alert(message);
    }
  }, [facing, pushError]);
  
useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }

      if (searchDelayRef.current) {
        clearTimeout(searchDelayRef.current);
        searchDelayRef.current = null;
      }

      captureSeqRef.current += 1;
      searchRequestIdRef.current += 1;
      searchingRef.current = false;
    };
  }, []);

  const callVision = useCallback(async (imageBase64, prompt) => {
    const sessionKey = String(sessionKeys.OPENROUTER_API_KEY || "").trim();

    if (activeModel?.provider === "openrouter" && sessionKey) {
      return await callOpenRouterDirect({
        apiKey: sessionKey,
        modelId: activeModel.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
              },
            ],
          },
        ],
      });
    }

    const response = await fetch("/api/vision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64, prompt }),
    });
    const data = await readJsonResponse(response, "/api/vision");
    if (!response.ok) throw new Error(data?.error || `vision HTTP ${response.status}`);
    return (data.text || "").trim();
  }, [activeModel, sessionKeys]);

  const callSearch = useCallback(async (prompt) => {
    const sessionKey = String(sessionKeys.OPENROUTER_API_KEY || "").trim();

    if (activeModel?.provider === "openrouter" && sessionKey) {
      const text = await callOpenRouterDirect({
        apiKey: sessionKey,
        modelId: activeModel.model,
        messages: [{ role: "user", content: prompt }],
      });
      return { text, model: activeModel.model };
    }

    const response = await fetch("/api/anthropic-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = await readJsonResponse(response, "/api/anthropic-search");
    if (!response.ok) throw new Error(data?.error || `search HTTP ${response.status}`);
    return { text: (data.text || "").trim(), model: data.model };
  }, [activeModel, sessionKeys]);

  const runAgentVision = useCallback(
    async (base64) => {
      let lastError = null;
      let lastRaw = "";
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const rawText = await callVision(base64, VISION_PROMPT);
          lastRaw = rawText;
          const parsed = parseModelJson(rawText);
          return normalizeCapture(parsed);
        } catch (e) {
          lastError = e;
          pushError(
            "vision",
            `محاولة ${attempt}/2: ${e.message}`,
            lastRaw ? `raw=${lastRaw.slice(0, 240)}` : ""
          );
        }
      }
      throw lastError || new Error("فشل Vision agent");
    },
    [callVision, pushError]
  );

const runSearch = useCallback(
    async (textToSearch, translationHint = "", { force = false, delayMs = 0 } = {}) => {
      const q = (textToSearch || "").trim();
      if (!q) return;

      if (searchDelayRef.current) {
        clearTimeout(searchDelayRef.current);
        searchDelayRef.current = null;
      }

      if (delayMs > 0) {
        const requestId = ++searchRequestIdRef.current;

        searchDelayRef.current = setTimeout(async () => {
          searchDelayRef.current = null;

          if (requestId !== searchRequestIdRef.current) return;
          await runSearch(q, translationHint, { force, delayMs: 0 });
        }, delayMs);

        return;
      }

      if (!force && q === lastSearchKeyRef.current) return;

      const requestId = ++searchRequestIdRef.current;
      searchingRef.current = true;
      lastSearchKeyRef.current = q;
      setSearching(true);
      setSearchError("");
      setSearchInfo("");

      try {
        const prompt = buildAnswerPrompt(q, translationHint);
        const { text } = await callSearch(prompt);

        if (requestId !== searchRequestIdRef.current) return;

        if (text) {
          setSearchInfo(text);
        } else {
          setSearchError("مقدرش ألاقي إجابة دلوقتي.");
          pushError("answer", "رد الإجابة فاضي", q);
        }
      } catch (e) {
        if (requestId !== searchRequestIdRef.current) return;

        const msg = e.message || "حصل خطأ أثناء جلب الإجابة.";
        setSearchError(msg);
        pushError("answer", msg, q);
      } finally {
        if (requestId === searchRequestIdRef.current) {
          searchingRef.current = false;
          setSearching(false);
        }
      }
    },
    [callSearch, pushError]
  );

  const captureAndTranslate = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current || busyRef.current) return;
    const video = videoRef.current;
    if (video.videoWidth === 0) return;

    const gapMs = intervalMsRef.current + 1000;
    const now = Date.now();
    if (now - lastRequestAtRef.current < gapMs) return;

    if (activeModel && !activeModel.supportsVision) {
      pushError(
        "agent",
        `الموديل "${activeModel.name}" مش Vision — غيّره من الإعدادات`
      );
      setRunning(false);
      return;
    }

    // 1) تطابق صورة 100% مع آخر إطار اتعالج → متبعتش Vision خالص
    const frameHash = fingerprintVideoFrame(video, canvasRef.current);
    if (frameHash && frameHash === lastImageHashRef.current) {
      return;
    }

    // 0) أي التقاط جديد بيلغي أي إجابة مجدولة أو جارية من التقاط أقدم
    const requestCaptureSeq = ++captureSeqRef.current;
    if (searchDelayRef.current) {
      clearTimeout(searchDelayRef.current);
      searchDelayRef.current = null;
    }
    searchRequestIdRef.current += 1;
    searchingRef.current = false;
    setSearching(false);

    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.75);
    const base64 = dataUrl.split(",")[1];

    lastRequestAtRef.current = Date.now();
    busyRef.current = true;
    setBusy(true);
    try {
      const captured = await runAgentVision(base64);
      if (requestCaptureSeq !== captureSeqRef.current) return;
      if (!captured.length) {
        // حتى لو مفيش نص، ثبّت بصمة الإطار عشان منعيدش على نفس الفاضي
        if (frameHash) lastImageHashRef.current = frameHash;
        return;
      }

      const captureKey = normalizeTextKey(captured.map((l) => l.original).join("||"));

      // 2) تطابق نص 100% مع اللي في الميموري → متحدثش UI ومتجبش إجابة تاني
      if (captureKey && captureKey === lastCaptureKeyRef.current) {
        if (frameHash) lastImageHashRef.current = frameHash;
        return;
      }

      lastCaptureKeyRef.current = captureKey;
      if (frameHash) lastImageHashRef.current = frameHash;

      setLines(captured);
      searchRequestIdRef.current += 1;
      searchingRef.current = false;
      setSearching(false);
      setSearchInfo("");
      setSearchError("");
      lastSearchKeyRef.current = "";

      const first = captured[0];

      // مهلة 6 ثواني قبل جلب الإجابة — أي التقاط أحدث أو إيقاف بيلغيها
      searchDelayRef.current = setTimeout(() => {
        searchDelayRef.current = null;
        if (requestCaptureSeq !== captureSeqRef.current) return;
        if (!runningRef.current) return;
        runSearch(first.original, first.translation, { force: true });
      }, 6000);
    } catch (e) {
      pushError("agent", e.message || "فشل مسار الترجمة");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [activeModel, runAgentVision, runSearch, pushError]);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  useEffect(() => {
    if (!running) {
      // إيقاف صريح من المستخدم: منع أي إجابة مجدولة أو جارية من إطار قديم
      captureSeqRef.current += 1;
      searchRequestIdRef.current += 1;
      searchingRef.current = false;
      setSearching(false);

      if (searchDelayRef.current) {
        clearTimeout(searchDelayRef.current);
        searchDelayRef.current = null;
      }

      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }
    captureAndTranslate();
    intervalRef.current = setInterval(captureAndTranslate, interval_);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [running, interval_, captureAndTranslate]);

  const toggleRunning = () => setRunning((r) => !r);

 const flipCamera = async () => {
    lastImageHashRef.current = "";
    const nextFacing =
      facing === "environment" ? "user" : "environment";

    setFacing(nextFacing);
    await startCamera(nextFacing);
  };

  const forceRecapture = () => {
    lastImageHashRef.current = "";
    lastCaptureKeyRef.current = "";
    lastSearchKeyRef.current = "";
    lastRequestAtRef.current = 0;
    captureAndTranslate();
  };

  const openSettings = async () => {
    setShowSettings(true);
    setEditing(false);
    setDraft(EMPTY_DRAFT);
    setSettingsError("");
    setSettingsOk("");
    setKeyDrafts({});
    await refreshModels();
  };

  const saveKeys = async () => {
    const payload = {};
    for (const [envKey, value] of Object.entries(keyDrafts)) {
      if (String(value || "").trim()) payload[envKey] = String(value).trim();
    }
    if (!Object.keys(payload).length) {
      setSettingsError("اكتب مفتاح جديد في خانة واحدة على الأقل قبل الحفظ.");
      return;
    }
    setSettingsBusy(true);
    setSettingsError("");
    setSettingsOk("");

    // الأهم: المفتاح بيتحفظ في المتصفح فورًا حتى لو الـ /api مش موجود
    const nextSessionKeys = { ...sessionKeys, ...payload };
    setSessionKeys(nextSessionKeys);
    setKeySlots((slots) => mergeKeySlots(slots, nextSessionKeys));
    setKeyDrafts({});

    let persistedForTab = false;
    try {
      writeSessionKeys(nextSessionKeys);
      persistedForTab = true;
    } catch (e) {
      pushError("keys-storage", e.message);
    }

    if (persistedForTab) {
      setSettingsOk("المفتاح اتحفظ في المتصفح (sessionStorage) وشغال على طول.");
    } else {
      setSettingsError(
        "المفتاح شغال في الصفحة الحالية بس — المتصفح منع التخزين، فلو عملت Refresh هتحتاج تلصقه تاني."
      );
      setSettingsOk("");
    }

    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await readJsonResponse(res, "/api/keys");
      if (!res.ok) throw new Error(data?.error || `فشل حفظ المفاتيح (HTTP ${res.status})`);
      setKeySlots(mergeKeySlots(data.keys || [], nextSessionKeys));
      setSettingsOk(
        persistedForTab
          ? "المفاتيح اتحفظت في المتصفح وفي keys.json."
          : "المفاتيح اتحفظت في keys.json (المتصفح منع التخزين المحلي)."
      );
    } catch (e) {
      // الـ API اختياري: بنكمل بالمفتاح اللي في المتصفح من غير ما نوقف الجلسة
      pushError(
        "keys-save",
        "حفظ المفاتيح على السيرفر فشل — المفتاح شغال من المتصفح",
        e.message
      );
    } finally {
      setSettingsBusy(false);
    }
  };

  const selectModel = async (id) => {
    setSettingsBusy(true);
    setSettingsError("");
    try {
      const res = await fetch("/api/models/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await readJsonResponse(res);
      if (!res.ok) throw new Error(data?.error || "فشل تفعيل الموديل");
      setActiveId(data.activeId);
    } catch (e) {
      setSettingsError(e.message);
      pushError("model-active", e.message);
    } finally {
      setSettingsBusy(false);
    }
  };

  const startEdit = (model) => {
    setEditing(true);
    setDraft({
      id: model.id,
      name: model.name,
      provider: model.provider || "openrouter",
      model: model.model || "",
      supportsVision: Boolean(model.supportsVision),
    });
  };

  const applyPreset = (preset) => {
    setEditing(true);
    setDraft({
      id: models.some((m) => m.id === preset.id) ? preset.id : "",
      name: preset.name,
      provider: preset.provider,
      model: preset.model,
      supportsVision: Boolean(preset.supportsVision),
    });
  };

  const startCreate = () => {
    setEditing(true);
    setDraft({ ...EMPTY_DRAFT });
  };

  const saveModel = async () => {
    setSettingsBusy(true);
    setSettingsError("");
    setSettingsOk("");
    try {
      const payload = {
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name.trim() || draft.model.trim(),
        provider: draft.provider,
        model: draft.model.trim(),
        supportsVision: draft.supportsVision,
      };

      const res = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await readJsonResponse(res);
      if (!res.ok) throw new Error(data?.error || "فشل حفظ الموديل");
      await refreshModels();
      setEditing(false);
      setDraft(EMPTY_DRAFT);
      setSettingsOk("الموديل اتحفظ في models.json (من غير مفاتيح).");
    } catch (e) {
      setSettingsError(e.message);
      pushError("model-save", e.message);
    } finally {
      setSettingsBusy(false);
    }
  };

  const deleteModel = async (id) => {
    if (!confirm("تمسح الموديل ده من models.json؟")) return;
    setSettingsBusy(true);
    setSettingsError("");
    try {
      const res = await fetch(`/api/models/${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await readJsonResponse(res);
      if (!res.ok) throw new Error(data?.error || "فشل المسح");
      setModels(data.models || []);
      setActiveId(data.activeId || "");
    } catch (e) {
      setSettingsError(e.message);
      pushError("model-delete", e.message);
    } finally {
      setSettingsBusy(false);
    }
  };

  const providerMeta = PROVIDER_DEFAULTS[draft.provider] || PROVIDER_DEFAULTS.openrouter;

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col" dir="rtl">
      <header className="px-4 py-3 border-b border-neutral-800 flex items-center justify-between">
        <h1 className="text-base font-semibold tracking-tight">مترجم لايف</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-neutral-500 hidden sm:inline">إنجليزي / روسي ← عربي</span>
          <button
            onClick={() => setWideBox((w) => !w)}
            className={`text-neutral-400 hover:text-amber-400 p-1 rounded-md ${
              wideBox ? "bg-amber-600/20 text-amber-400" : ""
            }`}
            aria-label={wideBox ? "وضع الطول" : "وضع العرض"}
            title={wideBox ? "كارت بالطول" : "كارت بالعرض"}
          >
            {wideBox ? <RectangleVertical size={16} /> : <RectangleHorizontal size={16} />}
          </button>
          <button
            onClick={() => setShowErrors(true)}
            className="relative text-neutral-400 hover:text-amber-400 flex items-center gap-1 text-xs"
            aria-label="سجل الأخطاء"
          >
            <Bug size={16} />
            {errorLog.length > 0 && (
              <span className="min-w-5 h-5 px-1 rounded-full bg-red-600 text-white text-[10px] flex items-center justify-center">
                {errorLog.length}
              </span>
            )}
          </button>
          <button
            onClick={openSettings}
            className="text-neutral-400 hover:text-neutral-200"
            aria-label="الإعدادات"
          >
            <Settings size={18} />
          </button>
        </div>
      </header>

      <div className="relative flex-1 bg-black overflow-hidden">
       <video
  ref={videoRef}
  playsInline
  muted
  autoPlay
  className="w-full h-full object-cover"
  style={{ transform: facing === "user" ? "scaleX(-1)" : "none" }}
/>
        <canvas ref={canvasRef} className="hidden" />

        {busy && (
          <div className="absolute top-3 left-3 bg-black/40 backdrop-blur-sm px-3 py-1.5 rounded-full flex items-center gap-2 text-xs z-10">
            <Loader2 size={14} className="animate-spin" />
            Agent بيترجم...
          </div>
        )}

        <button
          onClick={flipCamera}
          className="absolute top-3 right-3 bg-black/40 backdrop-blur-sm p-2 rounded-full z-10"
          aria-label="قلب الكاميرا"
        >
          <RotateCcw size={16} />
        </button>

        {primaryLine && (
          <div
            className={`absolute z-10 pointer-events-none ${
              wideBox ? "inset-x-2 bottom-2" : "inset-x-3 bottom-3"
            }`}
          >
            <div
              className={`backdrop-blur-sm rounded-2xl border border-white/10 pointer-events-auto drop-shadow-lg ${
                wideBox
                  ? "bg-black/18 px-3 py-2.5 w-full max-w-none flex flex-row flex-wrap gap-x-4 gap-y-2 items-start"
                  : "bg-black/18 px-3.5 py-3 max-w-xl mx-auto space-y-1.5"
              }`}
            >
                           {primaryLine.translation && (
                <div className={wideBox ? "min-w-[30%] flex-1" : undefined}>
                  <p
                    dir="rtl"
                    className="text-right whitespace-pre-line text-base sm:text-lg leading-snug font-semibold text-amber-300 drop-shadow"
                  >
                    {primaryLine.translation}
                  </p>
                </div>
              )}
              {primaryLine.original && (
                <div className={wideBox ? "min-w-[30%] flex-1" : "border-t border-white/10 pt-1.5"}>
                  <p className="text-sm text-white/90 leading-relaxed drop-shadow" dir="ltr">
                    {primaryLine.original}
                  </p>
                </div>
              )}
              <div className={wideBox ? "min-w-[25%] flex-1" : "pt-1 border-t border-white/10"}>
                {searching ? (
                  <p className="text-xs text-emerald-200/90 flex items-center gap-1">
                    <Loader2 size={11} className="animate-spin" />
                    جاري الإجابة تلقائيًا...
                  </p>
                 ) : searchInfo ? (
                  <div className="text-left">
                    {renderFormattedAnswer(searchInfo)}
                  </div>
                ) : searchError ? (
                  <p className="text-xs text-red-200">{searchError}</p>
                ) : (
                  <p className="text-[11px] text-white/50">الإجابة هتظهر هنا تلقائي</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="bg-neutral-900 border-t border-neutral-800 px-4 py-4 space-y-3">
        {!primaryLine && (
          <p className="text-sm text-neutral-500 text-center py-1">
            وجّه الكاميرا على سطر واحد — الترجمة فوق / الأصل / الإجابة تحت · الالتقاط كل{" "}
            {interval_ / 1000}ث
          </p>
        )}

        {primaryLine && (
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={() => runSearch(primaryLine.original, primaryLine.translation, { force: true })}
              disabled={searching}
              className="flex items-center gap-2 text-xs text-amber-500 hover:text-amber-400 disabled:opacity-50"
            >
              {searching ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
              حدّث الإجابة
            </button>
            <button
              onClick={forceRecapture}
              disabled={busy}
              className="flex items-center gap-2 text-xs text-neutral-400 hover:text-neutral-200 disabled:opacity-50"
            >
              <Camera size={13} />
              صوّر من جديد
            </button>
          </div>
        )}

       <div className="flex items-center gap-3 pt-1">
 <button
            type="button"
            onClick={() => startCamera("environment")}
            className="flex-1 flex items-center justify-center gap-2 bg-sky-600 hover:bg-sky-500 transition-colors text-white font-medium py-3 rounded-xl"
          >
            <Camera size={18} />
            تشغيل الكاميرا
          </button>

  <button
    type="button"
    onClick={toggleRunning}
    className="flex-1 flex items-center justify-center gap-2 bg-amber-600 hover:bg-amber-500 transition-colors text-white font-medium py-3 rounded-xl"
  >
    {running ? <Pause size={18} /> : <Camera size={18} />}
    {running ? "إيقاف" : "ابدأ الترجمة اللايف"}
  </button>
</div>

        <div className="flex items-center justify-center gap-2 text-xs text-neutral-500 flex-wrap">
          <span>سرعة الالتقاط:</span>
          {[10000, 20000, 40000, 80000].map((ms) => (
            <button
              key={ms}
              onClick={() => setInterval_(ms)}
              className={`px-2 py-1 rounded-md ${
                interval_ === ms ? "bg-amber-600 text-white" : "bg-neutral-800"
              }`}
            >
              {ms / 1000}ث
            </button>
          ))}
        </div>
        <p className="text-[11px] text-neutral-600 text-center">
          نفس الصورة/نفس النص 100% = مفيش طلب جديد · قفل = الالتقاط + 1ث ·{" "}
          {activeModel ? activeModel.name : "جارٍ التحميل..."}
        </p>
      </div>

      {showErrors && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-3">
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl w-full max-w-md p-4 space-y-3 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <Bug size={16} /> سجل أخطاء الـ Agent ({errorLog.length})
              </h2>
              <button onClick={() => setShowErrors(false)} aria-label="إغلاق">
                <X size={18} />
              </button>
            </div>
            <p className="text-[11px] text-neutral-500">
              انسخ الأخطاء وابعتها عشان ندبج حلقة الـ AI. الأخطاء متتجاهلاش — متخزنة هنا.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => copyText(formatErrorLogText(), "اتنسخ السجل كامل")}
                disabled={!errorLog.length}
                className="flex-1 flex items-center justify-center gap-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-sm py-2 rounded-xl"
              >
                <Copy size={14} /> نسخ الكل
              </button>
              <button
                type="button"
                onClick={() => setErrorLog([])}
                disabled={!errorLog.length}
                className="px-3 py-2 rounded-xl bg-neutral-800 text-sm disabled:opacity-40"
              >
                مسح
              </button>
            </div>
            {copyOk && <p className="text-xs text-emerald-400">{copyOk}</p>}
            <div className="overflow-y-auto space-y-2 flex-1 min-h-0">
              {!errorLog.length ? (
                <p className="text-sm text-neutral-500 text-center py-8">مفيش أخطاء لسه</p>
              ) : (
                errorLog.map((e) => (
                  <div key={e.id} className="bg-neutral-800/70 rounded-xl p-3 space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-[11px] text-neutral-400" dir="ltr">
                        [{formatErrorTime(e.ts)}] {e.source}
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          copyText(
                            `[${formatErrorTime(e.ts)}] ${e.source}: ${e.message}${
                              e.detail ? `\n  detail: ${e.detail}` : ""
                            }`,
                            "اتنسخ الخطأ"
                          )
                        }
                        className="text-neutral-400 hover:text-neutral-200"
                        aria-label="نسخ"
                      >
                        <Copy size={13} />
                      </button>
                    </div>
                    <p className="text-xs text-red-200 leading-relaxed">{e.message}</p>
                    {e.detail && (
                      <p className="text-[11px] text-neutral-500 break-all" dir="ltr">
                        {e.detail}
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-3">
          <div className="box-border w-full min-w-0 max-w-md max-h-[90dvh] overflow-x-hidden overflow-y-auto bg-neutral-900 border border-neutral-800 rounded-2xl p-4 pb-[max(1rem,env(safe-area-inset-bottom))] space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">الإعدادات</h2>
              <button onClick={() => setShowSettings(false)} aria-label="إغلاق">
                <X size={18} />
              </button>
            </div>

            <div className="flex items-start gap-2 text-xs text-neutral-400 bg-neutral-800/50 rounded-lg p-2.5">
              <Info size={14} className="shrink-0 mt-0.5" />
              <span>
                حط مفتاح <b>OpenRouter</b> مرة واحدة، وبعدين ضيف أي model id. الأخطاء من زر الحشرة
                فوق عشان الندبج.
              </span>
            </div>

            {settingsError && <p className="text-xs text-red-400">{settingsError}</p>}
            {settingsOk && <p className="text-xs text-emerald-400">{settingsOk}</p>}

            <div className="space-y-3 border border-neutral-800 rounded-xl p-3">
              <p className="text-xs font-medium text-neutral-300">المفاتيح (مرة واحدة)</p>
              {keySlots.map((slot) => (
                <div key={slot.envKey} className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs text-neutral-400">{slot.label}</label>
                    <span className="text-[10px] text-neutral-500" dir="ltr">
                      {slot.set ? `${slot.masked} · ${slot.source}` : "ناقص"}
                    </span>
                  </div>
                  <input
                    type="password"
                    value={keyDrafts[slot.envKey] ?? sessionKeys[slot.envKey] ?? ""}
                    onChange={(e) =>
                      setKeyDrafts((d) => ({ ...d, [slot.envKey]: e.target.value }))
                    }
                    dir="ltr"
                    className="box-border block w-full min-w-0 max-w-full bg-neutral-800 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-500"
                    placeholder={slot.set ? "سيب فاضي أو الصق مفتاح جديد" : slot.envKey}
                  />
                  <p className="text-[10px] text-neutral-600">{slot.hint}</p>
                </div>
              ))}
              <button
                type="button"
                onClick={saveKeys}
                disabled={settingsBusy}
                className="w-full bg-neutral-100 text-neutral-900 font-medium py-2 rounded-xl text-sm disabled:opacity-50"
              >
                حفظ المفاتيح
              </button>
            </div>

            {!editing && presets.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-neutral-500">إضافة سريعة</p>
                <div className="flex flex-wrap gap-2">
                  {presets.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => applyPreset(p)}
                      className="text-[11px] px-2.5 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700"
                      title={p.note}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {modelsLoading ? (
              <div className="flex justify-center py-6">
                <Loader2 className="animate-spin text-neutral-500" size={20} />
              </div>
            ) : (
              <div className="space-y-2">
                {models.map((m) => {
                  const isActive = m.id === activeId;
                  return (
                    <div
                      key={m.id}
                      className={`rounded-xl border px-3 py-2.5 ${
                        isActive
                          ? "border-amber-600 bg-amber-950/20"
                          : "border-neutral-800 bg-neutral-800/40"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => selectModel(m.id)}
                          disabled={settingsBusy}
                          className="text-right flex-1"
                        >
                          <div className="flex items-center gap-2 text-sm font-medium">
                            {isActive && <Check size={14} className="text-amber-500" />}
                            {m.name}
                          </div>
                          <p className="text-[11px] text-neutral-500 mt-0.5" dir="ltr">
                            {m.provider} · {m.model} · {m.supportsVision ? "Vision" : "text"} ·{" "}
                            {m.hasApiKey ? "key ok" : "key missing"}
                          </p>
                        </button>
                        <div className="flex gap-1">
                          <button
                            type="button"
                            onClick={() => startEdit(m)}
                            className="text-[11px] text-neutral-400 hover:text-neutral-200 px-2 py-1"
                          >
                            تعديل
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteModel(m.id)}
                            className="text-neutral-500 hover:text-red-400 p-1"
                            aria-label="مسح"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {!editing ? (
              <button
                type="button"
                onClick={startCreate}
                className="w-full flex items-center justify-center gap-2 border border-dashed border-neutral-700 text-neutral-300 py-2.5 rounded-xl text-sm hover:border-neutral-500"
              >
                <Plus size={16} />
                إضافة موديل (اسم الـ model بس)
              </button>
            ) : (
              <div className="space-y-3 border-t border-neutral-800 pt-3">
                <p className="text-xs text-neutral-400">{draft.id ? "تعديل موديل" : "موديل جديد"}</p>

                <div className="space-y-1">
                  <label className="text-xs text-neutral-400">الموفر</label>
                  <select
                    value={draft.provider}
                    onChange={(e) => {
                      const provider = e.target.value;
                      const defaults =
                        PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.openrouter;
                      setDraft((d) => {
                        const prevDefaults =
                          PROVIDER_DEFAULTS[d.provider] || PROVIDER_DEFAULTS.openrouter;
                        // القيم المخصصة اللي المستخدم عدّلها بنفسه مش بتتغير مع تغيير المزوّد
                        const keepModel = Boolean(d.model) && d.model !== prevDefaults.model;
                        const keepName = Boolean(d.name) && d.name !== prevDefaults.nameHint;
                        return {
                          ...d,
                          provider,
                          supportsVision: defaults.supportsVision,
                          model: keepModel ? d.model : defaults.model,
                          name: keepName ? d.name : defaults.nameHint,
                        };
                      });
                    }}
                    className="w-full bg-neutral-800 rounded-lg px-3 py-2 text-sm outline-none"
                  >
                    <option value="openrouter">OpenRouter (أي موديل بنفس المفتاح)</option>
                    <option value="gemini">Google Gemini مباشر</option>
                    <option value="openai">OpenAI مباشر</option>
                    <option value="zenmux">ZenMux</option>
                    <option value="anthropic">Anthropic Claude</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-neutral-400">اسم للعرض</label>
                  <input
                    type="text"
                    value={draft.name}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                    className="box-border block w-full min-w-0 max-w-full bg-neutral-800 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-500"
                    placeholder={providerMeta.nameHint}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-neutral-400">Model ID</label>
                  <input
                    type="text"
                    value={draft.model}
                    onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
                    dir="ltr"
                    className="box-border block w-full min-w-0 max-w-full bg-neutral-800 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-500"
                    placeholder={providerMeta.modelPlaceholder}
                  />
                </div>

                <label className="flex items-center gap-2 text-xs text-neutral-400">
                  <input
                    type="checkbox"
                    checked={draft.supportsVision}
                    onChange={(e) => setDraft((d) => ({ ...d, supportsVision: e.target.checked }))}
                  />
                  بيدعم Vision (صور) — لازم للكاميرا
                </label>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={saveModel}
                    disabled={settingsBusy}
                    className="flex-1 bg-amber-600 hover:bg-amber-500 text-white font-medium py-2.5 rounded-xl disabled:opacity-50"
                  >
                    {settingsBusy ? "بيحفظ..." : "حفظ الموديل"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(false);
                      setDraft(EMPTY_DRAFT);
                    }}
                    className="px-4 py-2.5 rounded-xl bg-neutral-800 text-sm"
                  >
                    إلغاء
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
