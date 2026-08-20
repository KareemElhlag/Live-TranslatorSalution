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
} from "lucide-react";

const DEFAULT_CONFIG = {
  useBuiltIn: true,
  baseUrl: "https://api.deepseek.com/chat/completions",
  apiKey: "",
  model: "deepseek-chat",
  supportsVision: false,
};

const STORAGE_KEY = "live-translator-config";

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

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
  const clean = (rawText || "").replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("invalid json");
    return JSON.parse(match[0]);
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
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [draftConfig, setDraftConfig] = useState(DEFAULT_CONFIG);

  useEffect(() => {
    const saved = loadConfig();
    setConfig(saved);
    setDraftConfig(saved);
  }, []);

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

  const callBuiltIn = useCallback(async ({ imageBase64, textPrompt }) => {
    const endpoint = imageBase64 ? "/api/vision" : "/api/anthropic-search";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        imageBase64 ? { imageBase64, prompt: textPrompt } : { prompt: textPrompt }
      ),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || `server error ${response.status}`);
    return (data.text || "").trim();
  }, []);

  const callCustomModel = useCallback(
    async (textPrompt, imageBase64) => {
      const response = await fetch("/api/custom-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          model: config.model,
          prompt: textPrompt,
          ...(imageBase64 ? { imageBase64 } : {}),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || `server error ${response.status}`);
      return (data.text || "").trim();
    },
    [config]
  );

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

        const textParts = config.useBuiltIn
          ? await callBuiltIn({ textPrompt: prompt })
          : await callCustomModel(prompt);

        if (textParts) {
          setSearchInfo(
            config.useBuiltIn
              ? textParts
              : `${textParts}\n\n(ملاحظة: الموديل المخصص مش بيعمل بحث حي في الإنترنت، الإجابة دي من معرفة الموديل نفسه بس)`
          );
        } else {
          setSearchError("مقدرش ألاقي معلومات إضافية دلوقتي.");
        }
      } catch {
        setSearchError(
          config.useBuiltIn
            ? "حصل خطأ أثناء البحث، جرب تاني."
            : "حصل خطأ في نداء الموديل المخصص عن طريق السيرفر - راجع الـ Base URL / API Key / اسم الموديل في الإعدادات."
        );
      } finally {
        searchingRef.current = false;
        setSearching(false);
      }
    },
    [original, config, callBuiltIn, callCustomModel]
  );

  const captureAndTranslate = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current || busyRef.current) return;
    const video = videoRef.current;
    if (video.videoWidth === 0) return;

    const canReadImage = config.useBuiltIn || config.supportsVision;
    if (!canReadImage) {
      setError('الموديل الحالي مش بيدعم قراءة الصور. فعّل "الموديل المدمج" من الإعدادات أو اختار موديل يدعم Vision.');
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

      const rawText = config.useBuiltIn
        ? await callBuiltIn({ imageBase64: base64, textPrompt: prompt })
        : await callCustomModel(prompt, base64);

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
    } catch {
      setError("حصل خطأ في الترجمة، هنحاول تاني.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [config, callBuiltIn, callCustomModel, runSearch]);

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

  const toggleRunning = () => {
    setRunning((r) => !r);
  };

  const flipCamera = () => {
    setFacing((f) => (f === "environment" ? "user" : "environment"));
  };

  const openSettings = () => {
    setDraftConfig(config);
    setShowSettings(true);
  };

  const saveSettings = () => {
    setConfig(draftConfig);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(draftConfig));
    setShowSettings(false);
  };

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
          الموديل الحالي: {config.useBuiltIn ? "المدمج (Claude)" : `مخصص — ${config.model || "بدون اسم"}`}
        </p>
      </div>

      {showSettings && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-3">
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl w-full max-w-md p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">إعدادات الموديل</h2>
              <button onClick={() => setShowSettings(false)} aria-label="إغلاق">
                <X size={18} />
              </button>
            </div>

            <label className="flex items-center justify-between gap-3 bg-neutral-800/60 rounded-lg px-3 py-2.5">
              <span className="text-sm">استخدام الموديل المدمج (المفتاح في السيرفر)</span>
              <input
                type="checkbox"
                checked={draftConfig.useBuiltIn}
                onChange={(e) => setDraftConfig((c) => ({ ...c, useBuiltIn: e.target.checked }))}
              />
            </label>

            {!draftConfig.useBuiltIn && (
              <div className="space-y-3">
                <div className="flex items-start gap-2 text-xs text-amber-500/90 bg-amber-950/30 border border-amber-900/50 rounded-lg p-2.5">
                  <Info size={14} className="shrink-0 mt-0.5" />
                  <span>
                    المفتاح بيتبعت لسيرفرك (/api/custom-proxy) وهو اللي بينادي الموفر. استخدم HTTPS دايمًا.
                    معظم موديلات DeepSeek النصية مش بتقرأ صور حتى لو فعّلت الـ checkbox.
                  </span>
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-neutral-400">Base URL</label>
                  <input
                    type="text"
                    value={draftConfig.baseUrl}
                    onChange={(e) => setDraftConfig((c) => ({ ...c, baseUrl: e.target.value }))}
                    dir="ltr"
                    className="w-full bg-neutral-800 rounded-lg px-3 py-2 text-sm outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-neutral-400">API Key</label>
                  <input
                    type="password"
                    value={draftConfig.apiKey}
                    onChange={(e) => setDraftConfig((c) => ({ ...c, apiKey: e.target.value }))}
                    dir="ltr"
                    className="w-full bg-neutral-800 rounded-lg px-3 py-2 text-sm outline-none"
                    placeholder="sk-..."
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-neutral-400">Model</label>
                  <input
                    type="text"
                    value={draftConfig.model}
                    onChange={(e) => setDraftConfig((c) => ({ ...c, model: e.target.value }))}
                    dir="ltr"
                    className="w-full bg-neutral-800 rounded-lg px-3 py-2 text-sm outline-none"
                  />
                </div>

                <label className="flex items-center gap-2 text-xs text-neutral-400">
                  <input
                    type="checkbox"
                    checked={draftConfig.supportsVision}
                    onChange={(e) =>
                      setDraftConfig((c) => ({ ...c, supportsVision: e.target.checked }))
                    }
                  />
                  الموديل ده بيقرأ صور (Vision)
                </label>
              </div>
            )}

            <button
              onClick={saveSettings}
              className="w-full bg-amber-600 hover:bg-amber-500 text-white font-medium py-2.5 rounded-xl"
            >
              حفظ
            </button>
            <p className="text-[11px] text-neutral-600 text-center">
              الإعدادات بتتحفظ في المتصفح، مش على السيرفر.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
