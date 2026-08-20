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

function looksLikeQuestion(original, translatedArabic) {
  const src = (original || "").trim();
  const ar = (translatedArabic || "").trim();
  if (!src && !ar) return false;
  if (/[?؟]\s*$/.test(src) || /[?؟]\s*$/.test(ar)) return true;
  const starters =
    /^(what|why|how|where|when|who|which|is|are|do|does|did|can|could|will|would|что|как|почему|где|когда|кто|какой|можно ли)\b/i;
  return starters.test(src);
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

  throw new Error("الموديل رجّع رد مش JSON. جرّب موديل Vision تاني أو زوّد وضوح النص في الصورة.");
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

export default function LiveTranslator() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const intervalRef = useRef(null);
  const busyRef = useRef(false);
  const searchingRef = useRef(false);

  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [original, setOriginal] = useState("");
  const [translated, setTranslated] = useState("");
  const [interval_, setInterval_] = useState(3000);
  const [facing, setFacing] = useState("environment");
  const [searching, setSearching] = useState(false);
  const [searchInfo, setSearchInfo] = useState("");
  const [searchError, setSearchError] = useState("");
  const [autoSearched, setAutoSearched] = useState(false);

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
        } catch {
          setPresets([]);
        }
      }
      if (keysRes.ok) {
        try {
          const keysData = await readJsonResponse(keysRes);
          setKeySlots(keysData.keys || []);
        } catch {
          setKeySlots([]);
        }
      }
    } catch (e) {
      setSettingsError(e.message);
      setError(e.message);
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshModels();
  }, [refreshModels]);

  const startCamera = useCallback(async () => {
    setError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("المتصفح ده مش بيدعم الكاميرا. جرّب Chrome أو Safari وعلى HTTPS.");
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
    } catch {
      setError("مقدرش أوصل للكاميرا. فعّل الإذن، واستخدم HTTPS بعد الديبلوي (الكاميرا مش بتشتغل على HTTP).");
    }
  }, [facing]);

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
    if (!response.ok) throw new Error(data?.error || `server error ${response.status}`);
    return (data.text || "").trim();
  }, []);

  const callSearch = useCallback(async (prompt) => {
    const response = await fetch("/api/anthropic-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data?.error || `server error ${response.status}`);
    return { text: (data.text || "").trim(), model: data.model };
  }, []);

  const runSearch = useCallback(
    async (textToSearch) => {
      const q = textToSearch ?? original;
      if (!q || searchingRef.current) return;
      searchingRef.current = true;
      setSearching(true);
      setAutoSearched(true);
      setSearchError("");
      setSearchInfo("");
      try {
        const prompt = `Search the web for helpful context about this text that was captured from a camera: "${q}". It could be a product, a sign, a menu item, a place, a brand, or general information, or it could be a question someone is asking about what they're looking at. Give a short, useful explanation or answer in Arabic (3-5 sentences max), written for someone who just saw this in real life. Do not just repeat the translation, add real extra context.`;

        const { text, model } = await callSearch(prompt);
        if (text) {
          const note =
            model && !model.supportsWebSearch
              ? "\n\n(ملاحظة: الموديل الحالي مش بيعمل بحث حي، الإجابة من معرفة الموديل بس)"
              : "";
          setSearchInfo(`${text}${note}`);
        } else {
          setSearchError("مقدرش ألاقي معلومات إضافية دلوقتي.");
        }
      } catch (e) {
        setSearchError(e.message || "حصل خطأ أثناء البحث، جرب تاني.");
      } finally {
        searchingRef.current = false;
        setSearching(false);
      }
    },
    [original, callSearch]
  );

  const captureAndTranslate = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current || busyRef.current) return;
    const video = videoRef.current;
    if (video.videoWidth === 0) return;

    if (activeModel && !activeModel.supportsVision) {
      setError(
        `الموديل "${activeModel.name}" مش بيدعم قراءة الصور. من الإعدادات اختار موديل Vision (OpenRouter / Gemini).`
      );
      setRunning(false);
      return;
    }

    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    const base64 = dataUrl.split(",")[1];

    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const prompt =
        'Look at this image. If it contains readable English or Russian text, respond ONLY with a JSON object: {"found": true, "original": "<the text you see>", "translation": "<Arabic translation>"}. If there is no readable English/Russian text, respond ONLY with {"found": false}. No markdown, no extra words.';

      const rawText = await callVision(base64, prompt);
      const parsed = parseModelJson(rawText);
      if (parsed.found) {
        setOriginal(parsed.original || "");
        setTranslated(parsed.translation || "");
        setSearchInfo("");
        setSearchError("");
        setAutoSearched(false);

        if (looksLikeQuestion(parsed.original, parsed.translation)) {
          runSearch(parsed.original);
        }
      }
    } catch (e) {
      setError(e.message || "حصل خطأ في الترجمة، هنحاول تاني.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [activeModel, callVision, runSearch]);

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
      setError("");
    } catch (e) {
      setSettingsError(e.message);
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
          <span className="text-xs text-neutral-500">إنجليزي / روسي ← عربي</span>
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
          <div className="absolute top-3 left-3 bg-neutral-900/80 backdrop-blur px-3 py-1.5 rounded-full flex items-center gap-2 text-xs">
            <Loader2 size={14} className="animate-spin" />
            بيترجم...
          </div>
        )}

        <button
          onClick={flipCamera}
          className="absolute top-3 right-3 bg-neutral-900/80 backdrop-blur p-2 rounded-full"
          aria-label="قلب الكاميرا"
        >
          <RotateCcw size={16} />
        </button>

        {translated && (
          <div className="absolute bottom-3 left-3 right-3 bg-neutral-950/85 backdrop-blur rounded-xl px-4 py-3 space-y-1">
            <p className="text-lg leading-snug font-semibold text-amber-400">{translated}</p>
            {original && (
              <p className="text-xs text-neutral-400" dir="ltr">
                {original}
              </p>
            )}
          </div>
        )}

        {error && (
          <div className="absolute top-14 left-3 right-3 bg-red-950/90 border border-red-800 text-red-200 text-xs px-3 py-2 rounded-lg flex items-center gap-2">
            <AlertCircle size={14} className="shrink-0" />
            {error}
          </div>
        )}
      </div>

      <div className="bg-neutral-900 border-t border-neutral-800 px-4 py-4 space-y-3">
        {translated ? (
          <div className="space-y-2">
            <button
              onClick={() => runSearch(original)}
              disabled={searching}
              className="flex items-center gap-2 text-xs text-amber-500 hover:text-amber-400 disabled:opacity-50"
            >
              {searching ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
              {searching ? "بيدور على إجابة..." : autoSearched ? "دور تاني" : "ابحث عن معلومات إضافية"}
            </button>

            {searchInfo && (
              <div className="bg-neutral-800/60 rounded-lg p-3 text-sm leading-relaxed whitespace-pre-line">
                {searchInfo}
              </div>
            )}
            {searchError && <p className="text-xs text-red-400">{searchError}</p>}
          </div>
        ) : (
          <p className="text-sm text-neutral-500 text-center py-2">وجّه الكاميرا على نص وابدأ الترجمة</p>
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
          {[2000, 3000, 5000].map((ms) => (
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
          الموديل: {activeModel ? activeModel.name : "جارٍ التحميل..."}
          {activeModel?.supportsVision ? " · Vision" : activeModel ? " · نص فقط" : ""}
          {activeModel?.hasApiKey === false ? " · مفتاح ناقص" : ""}
        </p>
      </div>

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
                حط مفتاح <b>OpenRouter</b> مرة واحدة تحت، وبعدين ضيف أي model id من عندهم (Google أو
                OpenAI أو غيرهم). المفاتيح في <span dir="ltr">keys.json</span>، والموديلات في{" "}
                <span dir="ltr">models.json</span> من غير أسرار.
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
                        isActive ? "border-amber-600 bg-amber-950/20" : "border-neutral-800 bg-neutral-800/40"
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
