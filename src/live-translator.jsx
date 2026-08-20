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
} from "lucide-react";

const PROVIDER_DEFAULTS = {
  openrouter: {
    supportsVision: true,
    model: "google/gemini-2.0-flash-001",
    nameHint: "OpenRouter · موديل جديد",
    modelPlaceholder: "google/gemini-2.0-flash-001 أو openai/gpt-4o-mini أو أي slug",
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

const VISION_PROMPT =
  'You are a camera OCR+translate agent. Read the single most prominent English or Russian text near the center (one sentence or one question only). Reply with ONLY valid JSON, no markdown: {"found":true,"original":"<exact text>","translation":"<Arabic>"}. If nothing readable: {"found":false}.';

function looksLikeQuestion(original, translatedArabic) {
  const src = (original || "").trim();
  const ar = (translatedArabic || "").trim();
  if (!src && !ar) return false;
  if (/[?؟]\s*$/.test(src) || /[?؟]\s*$/.test(ar)) return true;
  const starters =
    /^(what|why|how|where|when|who|which|is|are|do|does|did|can|could|will|would|что|как|почему|где|когда|кто|какой|можно ли)\b/i;
  return starters.test(src);
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

  const match = clean.match(/\{[\s\S]*\}/);
  if (match) {
    parsed = tryParse(match[0]);
    if (parsed) return parsed;
  }

  const preview = clean.slice(0, 180).replace(/\s+/g, " ");
  throw new Error(`الموديل رجّع رد مش JSON. preview="${preview}"`);
}

async function readJsonResponse(response) {
  const raw = await response.text();
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    throw new Error(
      response.ok
        ? "السيرفر رجّع رد فاضي"
        : `السيرفر مش متاح (${response.status}). شغّل npm run dev`
    );
  }
  if (trimmed.startsWith("<") || trimmed.startsWith("<!")) {
    throw new Error(
      "الطلب وصل لصفحة HTML مش API. تأكد إن السيرفر شغال بـ npm run dev وإنك فاتح http://localhost:5173"
    );
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(
      response.ok
        ? `رد مش مفهوم من السيرفر: ${trimmed.slice(0, 80)}`
        : trimmed.slice(0, 160) || `server error ${response.status}`
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

export default function LiveTranslator() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const intervalRef = useRef(null);
  const busyRef = useRef(false);
  const searchingRef = useRef(false);
  const lastCaptureKeyRef = useRef("");
  const lastSearchKeyRef = useRef("");
  const lastRequestAtRef = useRef(0);
  const intervalMsRef = useRef(10000);

  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState([]);
  const [interval_, setInterval_] = useState(10000);
  const [facing, setFacing] = useState("environment");
  const [searching, setSearching] = useState(false);
  const [searchInfo, setSearchInfo] = useState("");
  const [searchError, setSearchError] = useState("");
  const [errorLog, setErrorLog] = useState([]);
  const [showErrors, setShowErrors] = useState(false);
  const [copyOk, setCopyOk] = useState("");

  const [showSettings, setShowSettings] = useState(false);
  const [models, setModels] = useState([]);
  const [presets, setPresets] = useState([]);
  const [keySlots, setKeySlots] = useState([]);
  const [keyDrafts, setKeyDrafts] = useState({});
  const [activeId, setActiveId] = useState("");
  const [modelsLoading, setModelsLoading] = useState(true);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [settingsOk, setSettingsOk] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);

  const activeModel = models.find((m) => m.id === activeId) || models[0] || null;
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
    try {
      const [modelsRes, presetsRes, keysRes] = await Promise.all([
        fetch("/api/models"),
        fetch("/api/models/presets"),
        fetch("/api/keys"),
      ]);
      const data = await readJsonResponse(modelsRes);
      if (!modelsRes.ok) throw new Error(data?.error || "فشل تحميل الموديلات");
      setModels(data.models || []);
      setActiveId(data.activeId || data.models?.[0]?.id || "");

      if (presetsRes.ok) {
        try {
          const presetData = await readJsonResponse(presetsRes);
          setPresets(presetData.presets || []);
        } catch (e) {
          pushError("presets", e.message);
          setPresets([]);
        }
      }
      if (keysRes.ok) {
        try {
          const keysData = await readJsonResponse(keysRes);
          setKeySlots(keysData.keys || []);
        } catch (e) {
          pushError("keys", e.message);
          setKeySlots([]);
        }
      }
    } catch (e) {
      setSettingsError(e.message);
      pushError("models", e.message);
    } finally {
      setModelsLoading(false);
    }
  }, [pushError]);

  useEffect(() => {
    refreshModels();
  }, [refreshModels]);

  const startCamera = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        pushError("camera", "المتصفح مش بيدعم الكاميرا — استخدم Chrome/Safari وHTTPS");
        return;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch (e) {
      pushError("camera", "مقدرش أوصل للكاميرا", e.message);
    }
  }, [facing, pushError]);

  useEffect(() => {
    startCamera();
    return () => {
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, [startCamera]);

  const callVision = useCallback(async (imageBase64, prompt) => {
    const response = await fetch("/api/vision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64, prompt }),
    });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data?.error || `vision HTTP ${response.status}`);
    return (data.text || "").trim();
  }, []);

  const callSearch = useCallback(async (prompt) => {
    const response = await fetch("/api/anthropic-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data?.error || `search HTTP ${response.status}`);
    return { text: (data.text || "").trim(), model: data.model };
  }, []);

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
    async (textToSearch, translationHint = "", { force = false } = {}) => {
      const q = (textToSearch || "").trim();
      if (!q || searchingRef.current) return;
      if (!force && q === lastSearchKeyRef.current) return;

      searchingRef.current = true;
      lastSearchKeyRef.current = q;
      setSearching(true);
      setSearchError("");
      setSearchInfo("");
      try {
        const isQ = looksLikeQuestion(q, translationHint);
        const prompt = isQ
          ? `The user pointed a camera at this question: "${q}". Answer in Arabic in 2-3 short sentences. Be concrete. Do not only translate.`
          : `The user pointed a camera at this text: "${q}". Give a short useful explanation in Arabic (2-3 sentences). Do not only repeat the translation.`;

        const { text } = await callSearch(prompt);
        if (text) setSearchInfo(text);
        else {
          setSearchError("مقدرش ألاقي إجابة دلوقتي.");
          pushError("answer", "رد الإجابة فاضي", q);
        }
      } catch (e) {
        const msg = e.message || "حصل خطأ أثناء جلب الإجابة.";
        setSearchError(msg);
        pushError("answer", msg, q);
      } finally {
        searchingRef.current = false;
        setSearching(false);
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
      if (!captured.length) return;

      const captureKey = captured.map((l) => l.original).join("||");
      if (captureKey === lastCaptureKeyRef.current) return;
      lastCaptureKeyRef.current = captureKey;

      setLines(captured);
      setSearchInfo("");
      setSearchError("");
      lastSearchKeyRef.current = "";

      const first = captured[0];
      runSearch(first.original, first.translation);
    } catch (e) {
      pushError("agent", e.message || "فشل مسار الترجمة");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [activeModel, runAgentVision, runSearch, pushError]);

  useEffect(() => {
    if (!running) {
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

  const flipCamera = () => {
    setFacing((f) => (f === "environment" ? "user" : "environment"));
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
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await readJsonResponse(res);
      if (!res.ok) throw new Error(data?.error || "فشل حفظ المفاتيح");
      setKeySlots(data.keys || []);
      setKeyDrafts({});
      setSettingsOk("المفاتيح اتحفظت في keys.json (مش بتترفع على Git).");
      await refreshModels();
    } catch (e) {
      setSettingsError(e.message);
      pushError("keys-save", e.message);
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
          <div className="absolute inset-x-3 bottom-3 z-10 pointer-events-none">
            <div className="bg-black/35 backdrop-blur-md rounded-2xl px-3.5 py-3 border border-white/15 space-y-1.5 max-w-xl mx-auto pointer-events-auto">
              {primaryLine.translation && (
                <p className="text-base sm:text-lg leading-snug font-semibold text-amber-300 drop-shadow">
                  {primaryLine.translation}
                </p>
              )}
              {primaryLine.original && (
                <p className="text-sm text-white/90 leading-relaxed drop-shadow" dir="ltr">
                  {primaryLine.original}
                </p>
              )}
              <div className="pt-1 border-t border-white/10">
                {searching ? (
                  <p className="text-xs text-emerald-200/90 flex items-center gap-1">
                    <Loader2 size={11} className="animate-spin" />
                    جاري الإجابة تلقائيًا...
                  </p>
                ) : searchInfo ? (
                  <p className="text-sm text-emerald-100/95 leading-relaxed whitespace-pre-line">
                    {searchInfo}
                  </p>
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
          <button
            onClick={() => runSearch(primaryLine.original, primaryLine.translation, { force: true })}
            disabled={searching}
            className="flex items-center gap-2 text-xs text-amber-500 hover:text-amber-400 disabled:opacity-50"
          >
            {searching ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
            حدّث الإجابة
          </button>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={toggleRunning}
            className="flex-1 flex items-center justify-center gap-2 bg-amber-600 hover:bg-amber-500 transition-colors text-white font-medium py-3 rounded-xl"
          >
            {running ? <Pause size={18} /> : <Camera size={18} />}
            {running ? "إيقاف" : "ابدأ الترجمة اللايف"}
          </button>
        </div>

        <div className="flex items-center justify-center gap-2 text-xs text-neutral-500">
          <span>سرعة الالتقاط:</span>
          {[5000, 10000, 15000].map((ms) => (
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
          قفل الطلبات = الالتقاط + 1ث · الموديل:{" "}
          {activeModel ? activeModel.name : "جارٍ التحميل..."}
          {activeModel?.supportsVision ? " · Vision" : activeModel ? " · نص فقط" : ""}
          {activeModel?.hasApiKey === false ? " · مفتاح ناقص" : ""}
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
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl w-full max-w-md p-4 space-y-4 max-h-[90vh] overflow-y-auto">
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
                    value={keyDrafts[slot.envKey] || ""}
                    onChange={(e) =>
                      setKeyDrafts((d) => ({ ...d, [slot.envKey]: e.target.value }))
                    }
                    dir="ltr"
                    className="w-full bg-neutral-800 rounded-lg px-3 py-2 text-sm outline-none"
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
                      const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.openrouter;
                      setDraft((d) => ({
                        ...d,
                        provider,
                        supportsVision: defaults.supportsVision,
                        model: d.model || defaults.model,
                        name: d.name || defaults.nameHint,
                      }));
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
                    className="w-full bg-neutral-800 rounded-lg px-3 py-2 text-sm outline-none"
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
                    className="w-full bg-neutral-800 rounded-lg px-3 py-2 text-sm outline-none"
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
