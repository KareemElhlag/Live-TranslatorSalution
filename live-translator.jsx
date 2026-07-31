import React, { useRef, useState, useEffect, useCallback } from "react";
import { Camera, Loader2, Pause, Play, RotateCcw, AlertCircle, Search } from "lucide-react";

export default function LiveTranslator() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const intervalRef = useRef(null);

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

  const startCamera = useCallback(async () => {
    setError("");
    try {
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
      setError("مقدرش أوصل للكاميرا. تأكد من إعطاء الإذن للمتصفح.");
    }
  }, [facing]);

  useEffect(() => {
    startCamera();
    return () => {
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [startCamera]);

  const captureAndTranslate = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current || busy) return;
    const video = videoRef.current;
    if (video.videoWidth === 0) return;

    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    const base64 = dataUrl.split(",")[1];

    setBusy(true);
    setError("");
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/jpeg", data: base64 },
                },
                {
                  type: "text",
                  text:
                    "Look at this image. If it contains readable English or Russian text, respond ONLY with a JSON object: {\"found\": true, \"original\": \"<the text you see>\", \"translation\": \"<Arabic translation>\"}. If there is no readable English/Russian text, respond ONLY with {\"found\": false}. No markdown, no extra words.",
                },
              ],
            },
          ],
        }),
      });
      const data = await response.json();
      const textBlock = (data.content || []).find((b) => b.type === "text");
      if (!textBlock) throw new Error("no response");
      const clean = textBlock.text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      if (parsed.found) {
        setOriginal(parsed.original || "");
        setTranslated(parsed.translation || "");
        setSearchInfo("");
        setSearchError("");
      }
    } catch (e) {
      setError("حصل خطأ في الترجمة، هنحاول تاني.");
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const searchAboutText = useCallback(async () => {
    if (!original || searching) return;
    setSearching(true);
    setSearchError("");
    setSearchInfo("");
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [
            {
              role: "user",
              content: `Search the web for helpful context about this text that was captured from a camera: "${original}". It could be a product, a sign, a menu item, a place, a brand, or general information. Give a short, useful explanation in Arabic (3-5 sentences max), written for someone who just saw this in real life and wants to understand more about it. Do not just repeat the translation, add real extra context from your search.`,
            },
          ],
          tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
      });
      const data = await response.json();
      const textParts = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (textParts) {
        setSearchInfo(textParts);
      } else {
        setSearchError("مقدرش ألاقي معلومات إضافية دلوقتي.");
      }
    } catch (e) {
      setSearchError("حصل خطأ أثناء البحث، جرب تاني.");
    } finally {
      setSearching(false);
    }
  }, [original, searching]);

  const toggleRunning = () => {
    if (running) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
      setRunning(false);
    } else {
      setRunning(true);
      captureAndTranslate();
      intervalRef.current = setInterval(captureAndTranslate, interval_);
    }
  };

  const flipCamera = () => {
    setFacing((f) => (f === "environment" ? "user" : "environment"));
  };

  useEffect(() => {
    startCamera();
  }, [facing, startCamera]);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col" dir="rtl">
      <header className="px-4 py-3 border-b border-neutral-800 flex items-center justify-between">
        <h1 className="text-base font-semibold tracking-tight">مترجم لايف</h1>
        <span className="text-xs text-neutral-500">إنجليزي / روسي ← عربي</span>
      </header>

      <div className="relative flex-1 bg-black overflow-hidden">
        <video
          ref={videoRef}
          playsInline
          muted
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

        {error && (
          <div className="absolute bottom-3 left-3 right-3 bg-red-950/90 border border-red-800 text-red-200 text-xs px-3 py-2 rounded-lg flex items-center gap-2">
            <AlertCircle size={14} className="shrink-0" />
            {error}
          </div>
        )}
      </div>

      <div className="bg-neutral-900 border-t border-neutral-800 px-4 py-4 space-y-3">
        {translated ? (
          <div className="space-y-2">
            <p className="text-lg leading-relaxed font-medium">{translated}</p>
            {original && (
              <p className="text-xs text-neutral-500 border-t border-neutral-800 pt-2" dir="ltr">
                {original}
              </p>
            )}

            <button
              onClick={searchAboutText}
              disabled={searching}
              className="flex items-center gap-2 text-xs text-amber-500 hover:text-amber-400 disabled:opacity-50 pt-1"
            >
              {searching ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
              {searching ? "بيدور على الإنترنت..." : "ابحث عن معلومات إضافية"}
            </button>

            {searchInfo && (
              <div className="bg-neutral-800/60 rounded-lg p-3 text-sm leading-relaxed">
                {searchInfo}
              </div>
            )}
            {searchError && <p className="text-xs text-red-400">{searchError}</p>}
          </div>
        ) : (
          <p className="text-sm text-neutral-500 text-center py-2">
            وجّه الكاميرا على نص وابدأ الترجمة
          </p>
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
      </div>
    </div>
  );
}
