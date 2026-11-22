import React, { useRef, useState, useEffect, useCallback } from "react";
import {
  Camera,
  Loader2,
  RotateCcw,
  Search,
  Settings,
  X,
  Info,
  Plus,
  Trash2,
  Check,
  Copy,
  Bug,
  Play,
  Square,
  Maximize2,
  Minimize2,
  RefreshCw,
  AlertTriangle,
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

const SESSION_MODELS_STORAGE_KEY = "live-translator-session-models";

function readSessionModelStore() {
  try {
    const value = JSON.parse(
      window.sessionStorage.getItem(SESSION_MODELS_STORAGE_KEY) || "{}"
    );
    return {
      models: Array.isArray(value.models) ? value.models : [],
      activeId: typeof value.activeId === "string" ? value.activeId : "",
    };
  } catch {
    return { models: [], activeId: "" };
  }
}

function writeSessionModelStore(store) {
  window.sessionStorage.setItem(
    SESSION_MODELS_STORAGE_KEY,
    JSON.stringify(store)
  );
}

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

const ANSWER_HINT_RE =
  /no (?:multiple[- ]choice|question|options?|data|readable text)|no clear question|not enough (?:text|information|context|data)|(?:does not|doesn[’']?t|did not|didn[’']?t) (?:contain|show|include|have) enough|insufficient|cannot (?:read|determine|answer|find|see)|can[’']?t (?:read|determine|answer|find|see)|unable to (?:read|determine|answer|find|see)|could not (?:read|determine|find|see)|لا يوجد سؤال|مفيش سؤال|لا يمكن قراءة/i;

/** رد الموديل اللي معناه "مفيش سؤال واضح" — ده مش إجابة */
function looksLikeAnswerHint(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  // الردود الطويلة عادةً إجابة حقيقية؛ الفحص للحالات القصيرة بس
  if (value.length > 320) return false;
  return ANSWER_HINT_RE.test(value);
}

const OPTION_LINE_RE = /^\s*([A-Za-z]|\d{1,2}|[أ-د])\s*[)\].:\-]\s*(\S.*)$/;

/** يفصل نص السؤال عن اختيارات a) b) c) ويرجّع كل اختيار في سطر لوحده */
function splitChoices(text) {
  const raw = String(text || "").trim();
  if (!raw) return { body: "", options: [] };

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const options = [];
  const bodyLines = [];

  for (const line of lines) {
    const match = line.match(OPTION_LINE_RE);
    if (match) options.push({ label: match[1], text: match[2].trim() });
    else bodyLines.push(line);
  }

  if (options.length >= 2) return { body: bodyLines.join("\n"), options };

  const marker = /(?:^|\s)([A-Za-z]|\d{1,2}|[أ-د])\s*[)\].:\-]\s+(?=\S)/g;
  const hits = [];
  let found;
  while ((found = marker.exec(raw))) {
    hits.push({
      label: found[1],
      start: found.index,
      textStart: found.index + found[0].length,
    });
  }

  if (hits.length >= 2) {
    const body = raw.slice(0, hits[0].start).trim();
    const inlineOptions = hits.map((hit, index) => ({
      label: hit.label,
      text: raw
        .slice(hit.textStart, index + 1 < hits.length ? hits[index + 1].start : raw.length)
        .trim(),
    }));
    return { body, options: inlineOptions };
  }

  return { body: raw, options: [] };
}

function normalizeOptionText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findCorrectOptionIndex(options, letter, choiceText) {
  if (!options.length) return -1;

  const wanted = String(letter || "").trim().toLowerCase();
  if (wanted) {
    const byLabel = options.findIndex(
      (option) => String(option.label || "").trim().toLowerCase() === wanted
    );
    if (byLabel >= 0) return byLabel;
  }

  const target = normalizeOptionText(choiceText);
  if (!target) return -1;

  const exact = options.findIndex(
    (option) => normalizeOptionText(option.text) === target
  );
  if (exact >= 0) return exact;

  return options.findIndex((option) => {
    const value = normalizeOptionText(option.text);
    return Boolean(value) && (value.includes(target) || target.includes(value));
  });
}

/** يفكك رد الإجابة لـ: اختيار صح / خطوات / نص */
function parseAnswer(text) {
  const value = String(text || "").trim();
  if (!value) return { kind: "empty" };

  const correct = value.match(/Correct Answer:\s*([^\r\n]+)/i);
  if (correct) {
    const head = correct[1].trim();
    const choiceMatch = head.match(/^([A-Za-z]|\d{1,2}|[أ-د])\s*[)\].:\-]\s*(.+)$/);
    const explanation = value
      .slice(value.indexOf(correct[0]) + correct[0].length)
      .replace(/^\s*Reason:\s*/i, "")
      .trim();

    return {
      kind: "mcq",
      letter: choiceMatch ? choiceMatch[1] : "",
      choice: choiceMatch ? choiceMatch[2].trim() : head,
      explanation,
    };
  }

  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const steps = [];
  const prose = [];
  for (const line of lines) {
    const step = line.match(/^\d{1,2}[.)]\s*(.+)$/);
    if (step) steps.push(step[1].trim());
    else prose.push(line);
  }

  if (steps.length >= 2) {
    return { kind: "steps", steps, intro: prose.join("\n") };
  }

  return { kind: "text", text: value.replace(/^\s*Reason:\s*/i, "").trim() };
}

function CountdownRing({ seconds, total }) {
  const size = 44;
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = total > 0 ? Math.min(1, Math.max(0, seconds / total)) : 0;

  return (
    <div
      role="timer"
      aria-label={`${seconds} ثانية للالتقاط القادم`}
      className="relative h-11 w-11 rounded-full bg-black"
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90"
        aria-hidden="true"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#3f3f46"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#f59e0b"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
          style={{ transition: "stroke-dashoffset 0.25s linear" }}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[11px] font-bold text-amber-300">
        {seconds}
      </span>
    </div>
  );
}

function ChoiceLines({ options, lang = "ar", tone = "gold" }) {
  if (!options.length) return null;

  return (
    <ul className="mt-2 space-y-2">
      {options.map((option, index) => (
        <li key={`${option.label}-${index}`} className="flex items-start gap-2">
          <span
            className={`mt-0.5 flex h-5 min-w-5 shrink-0 items-center justify-center rounded px-1 text-[11px] font-bold ${
              tone === "gold"
                ? "bg-amber-600 text-black"
                : "bg-neutral-800 text-neutral-400"
            }`}
          >
            {option.label}
          </span>
          <span
            dir={lang === "en" ? "ltr" : "rtl"}
            className={`min-w-0 flex-1 [overflow-wrap:anywhere] ${
              lang === "en"
                ? "text-left text-[12px] leading-[1.6] text-neutral-400"
                : "text-right text-[17px] leading-[1.7] text-amber-300"
            }`}
          >
            {option.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({ icon, title, hint }) {
  return (
    <div className="flex min-h-[150px] flex-col items-center justify-center gap-2 px-4 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-full border border-neutral-800 bg-neutral-900 text-neutral-500">
        {icon}
      </span>
      <p className="text-sm font-semibold text-neutral-300">{title}</p>
      <p className="max-w-[32ch] text-xs leading-relaxed text-neutral-500">{hint}</p>
    </div>
  );
}

function TranslationCard({ line }) {
  const original = splitChoices(line?.original);
  const translation = splitChoices(line?.translation);

  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900 p-4">
      {line?.original ? (
        <div dir="ltr" className="text-left">
          <p dir="rtl" className="mb-1 text-[10px] font-semibold text-neutral-500">
            النص الأصلي
          </p>
          {original.body && (
            <p className="whitespace-pre-line text-[12px] leading-[1.6] text-neutral-400 [overflow-wrap:anywhere]">
              {original.body}
            </p>
          )}
          <ChoiceLines options={original.options} lang="en" tone="muted" />
        </div>
      ) : null}

      <div className="my-3 h-px bg-neutral-800" />

      {line?.translation ? (
        <div dir="rtl">
          <p className="mb-1 text-[10px] font-semibold text-amber-500">الترجمة</p>
          {translation.body && (
            <p className="text-[19px] font-semibold leading-[1.8] text-amber-300 [overflow-wrap:anywhere]">
              {translation.body}
            </p>
          )}
          <ChoiceLines options={translation.options} lang="ar" tone="gold" />
        </div>
      ) : (
        <p className="text-sm text-neutral-500">مفيش ترجمة للنص ده لسه…</p>
      )}
    </section>
  );
}

function AnswerCard({ text, line }) {
  const parsed = parseAnswer(text);
  const original = splitChoices(line?.original);
  const translated = splitChoices(line?.translation);

  if (parsed.kind === "mcq") {
    const correctIndex = findCorrectOptionIndex(
      original.options,
      parsed.letter,
      parsed.choice
    );

    return (
      <div className="space-y-3">
        <section className="rounded-2xl border border-emerald-500/40 bg-emerald-950 p-4">
          <p className="text-[11px] font-bold text-emerald-300">الإجابة الصحيحة</p>
          <div className="mt-2 flex items-start gap-2.5">
            {parsed.letter && (
              <span className="flex h-9 min-w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500 px-1.5 text-base font-bold text-emerald-950">
                {parsed.letter}
              </span>
            )}
            <p
              dir="ltr"
              className="min-w-0 flex-1 text-left text-[19px] font-semibold leading-[1.6] text-emerald-50 [overflow-wrap:anywhere]"
            >
              {parsed.choice}
            </p>
          </div>
          {parsed.explanation && (
            <p
              dir="ltr"
              className="mt-3 whitespace-pre-line border-t border-emerald-500/25 pt-3 text-left text-sm leading-[1.7] text-emerald-100 [overflow-wrap:anywhere]"
            >
              {parsed.explanation}
            </p>
          )}
        </section>

        {original.options.length > 0 && (
          <ul className="space-y-2">
            {original.options.map((option, index) => {
              const isCorrect = index === correctIndex;
              const arabic = translated.options[index]?.text || "";
              return (
                <li
                  key={`${option.label}-${index}`}
                  className={`rounded-xl border p-2.5 ${
                    isCorrect
                      ? "border-emerald-500 bg-emerald-950"
                      : "border-neutral-800 bg-neutral-900"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <span
                      className={`mt-0.5 flex h-6 min-w-6 shrink-0 items-center justify-center rounded px-1 text-[11px] font-bold ${
                        isCorrect
                          ? "bg-emerald-500 text-emerald-950"
                          : "bg-neutral-800 text-neutral-400"
                      }`}
                    >
                      {option.label}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p
                        dir="ltr"
                        className={`text-left text-sm leading-[1.6] [overflow-wrap:anywhere] ${
                          isCorrect ? "font-semibold text-emerald-50" : "text-neutral-300"
                        }`}
                      >
                        {option.text}
                      </p>
                      {arabic && (
                        <p
                          dir="rtl"
                          className="mt-1 text-right text-[13px] leading-[1.6] text-neutral-400 [overflow-wrap:anywhere]"
                        >
                          {arabic}
                        </p>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  if (parsed.kind === "steps") {
    return (
      <section className="rounded-2xl border border-emerald-500/40 bg-emerald-950 p-4">
        <p className="text-[11px] font-bold text-emerald-300">خطوات الحل</p>
        {parsed.intro && (
          <p
            dir="ltr"
            className="mt-2 whitespace-pre-line text-left text-sm leading-[1.7] text-emerald-100 [overflow-wrap:anywhere]"
          >
            {parsed.intro}
          </p>
        )}
        <ol dir="ltr" className="mt-3 space-y-2.5 text-left">
          {parsed.steps.map((step, index) => (
            <li key={`step-${index}`} className="flex items-start gap-2.5">
              <span className="flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-[12px] font-bold text-emerald-950">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 text-sm leading-[1.7] text-emerald-50 [overflow-wrap:anywhere]">
                {step}
              </span>
            </li>
          ))}
        </ol>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-emerald-500/40 bg-emerald-950 p-4">
      <p className="text-[11px] font-bold text-emerald-300">الإجابة</p>
      <p
        dir="ltr"
        className="mt-2 whitespace-pre-line text-left text-[15px] leading-[1.8] text-emerald-50 [overflow-wrap:anywhere]"
      >
        {parsed.text}
      </p>
    </section>
  );
}

const REGION_HANDLES = [
  { key: "nw", position: "left-0 top-0 -translate-x-1/2 -translate-y-1/2", cursor: "cursor-nwse-resize" },
  { key: "n", position: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2", cursor: "cursor-ns-resize" },
  { key: "ne", position: "right-0 top-0 translate-x-1/2 -translate-y-1/2", cursor: "cursor-nesw-resize" },
  { key: "w", position: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2", cursor: "cursor-ew-resize" },
  { key: "e", position: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2", cursor: "cursor-ew-resize" },
  { key: "sw", position: "bottom-0 left-0 -translate-x-1/2 translate-y-1/2", cursor: "cursor-nesw-resize" },
  { key: "s", position: "bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2", cursor: "cursor-ns-resize" },
  { key: "se", position: "bottom-0 right-0 translate-x-1/2 translate-y-1/2", cursor: "cursor-nwse-resize" },
];

/** إطار الالتقاط: ممشي (سحب) + ٨ مقابض للحجم بإحداثيات المؤشر */
function CaptureRegion({ region, onChange }) {
  const containerRef = useRef(null);
  const dragRef = useRef(null);
  const cleanupRef = useRef(null);

  const endDrag = useCallback(() => {
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }
    dragRef.current = null;
  }, []);

  useEffect(() => endDrag, [endDrag]);

  const startDrag = (event, mode) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;

    const box = containerRef.current?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return;

    event.preventDefault();
    endDrag();
    dragRef.current = {
      mode,
      base: { ...region },
      startX: event.clientX,
      startY: event.clientY,
      width: box.width,
      height: box.height,
    };

    const handleMove = (moveEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = (moveEvent.clientX - drag.startX) / drag.width;
      const dy = (moveEvent.clientY - drag.startY) / drag.height;
      onChange(moveOrResizeRegion(drag.base, drag.mode, dx, dy));
    };

    const handleEnd = () => endDrag();

    window.addEventListener("pointermove", handleMove, { passive: false });
    window.addEventListener("pointerup", handleEnd);
    window.addEventListener("pointercancel", handleEnd);
    cleanupRef.current = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleEnd);
    };
  };

  return (
    <div ref={containerRef} className="absolute inset-0 z-10">
      <div
        role="group"
        aria-label="منطقة الالتقاط: اسحب لتحريكها أو اسحب الحواف لتغيير حجمها"
        onPointerDown={(event) => startDrag(event, "move")}
        className="absolute cursor-move rounded-xl border-2 border-dashed border-amber-500"
        style={{
          left: `${region.x * 100}%`,
          top: `${region.y * 100}%`,
          width: `${region.w * 100}%`,
          height: `${region.h * 100}%`,
          touchAction: "none",
          boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.55)",
        }}
      >
        {REGION_HANDLES.map((handle) => (
          <span
            key={handle.key}
            onPointerDown={(event) => {
              event.stopPropagation();
              startDrag(event, handle.key);
            }}
            className={`absolute flex h-11 w-11 items-center justify-center ${handle.position} ${handle.cursor}`}
            style={{ touchAction: "none" }}
          >
            <span className="pointer-events-none block h-2.5 w-2.5 rounded-full border border-black bg-amber-400" />
          </span>
        ))}
      </div>
    </div>
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

const REGION_STORAGE_KEY = "live-translator-capture-region";

/** أصغر مساحة مسموحة للمنطقة (كنسبة من الكاميرا) — عشان متنهارش */
const REGION_MIN = { w: 0.12, h: 0.08 };

/** الافتراضي: نفس الإطار المتقطع القديم — شريط أفقي بعرض الكاميرا تقريبًا */
const DEFAULT_REGION = { x: 0.045, y: 0.2, w: 0.91, h: 0.6 };

const REGION_PRESETS = [
  { id: "line", label: "سطر", region: { x: 0.05, y: 0.42, w: 0.9, h: 0.16 } },
  { id: "question", label: "سؤال", region: { x: 0.06, y: 0.18, w: 0.88, h: 0.64 } },
  { id: "full", label: "كامل", region: { x: 0, y: 0, w: 1, h: 1 } },
];

function roundRegion(region) {
  const tight = (value) => Math.round(value * 10000) / 10000;
  return {
    x: tight(region.x),
    y: tight(region.y),
    w: tight(region.w),
    h: tight(region.h),
  };
}

function sanitizeRegion(value) {
  if (!value || typeof value !== "object") return { ...DEFAULT_REGION };
  const [x, y, w, h] = ["x", "y", "w", "h"].map((key) => Number(value[key]));
  if (![x, y, w, h].every((number) => Number.isFinite(number))) {
    return { ...DEFAULT_REGION };
  }

  const width = Math.min(Math.max(w, REGION_MIN.w), 1);
  const height = Math.min(Math.max(h, REGION_MIN.h), 1);

  return roundRegion({
    x: Math.min(Math.max(x, 0), 1 - width),
    y: Math.min(Math.max(y, 0), 1 - height),
    w: width,
    h: height,
  });
}

function readStoredRegion() {
  try {
    const raw = window.localStorage.getItem(REGION_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_REGION };
    return sanitizeRegion(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_REGION };
  }
}

function writeStoredRegion(region) {
  try {
    window.localStorage.setItem(REGION_STORAGE_KEY, JSON.stringify(region));
  } catch {
    // المتصفح ممكن يمنع التخزين — المنطقة بتفضل شغالة للجلسة الحالية
  }
}

function regionsMatch(a, b) {
  return (
    Math.abs(a.x - b.x) < 0.002 &&
    Math.abs(a.y - b.y) < 0.002 &&
    Math.abs(a.w - b.w) < 0.002 &&
    Math.abs(a.h - b.h) < 0.002
  );
}

function moveOrResizeRegion(base, mode, dx, dy) {
  let x = base.x;
  let y = base.y;
  let w = base.w;
  let h = base.h;

  if (mode === "move") {
    x += dx;
    y += dy;
  } else {
    if (mode.includes("w")) {
      x += dx;
      w -= dx;
    }
    if (mode.includes("e")) w += dx;
    if (mode.includes("n")) {
      y += dy;
      h -= dy;
    }
    if (mode.includes("s")) h += dy;

    if (w < REGION_MIN.w) {
      if (mode.includes("w")) x = base.x + base.w - REGION_MIN.w;
      w = REGION_MIN.w;
    }
    if (h < REGION_MIN.h) {
      if (mode.includes("n")) y = base.y + base.h - REGION_MIN.h;
      h = REGION_MIN.h;
    }
  }

  w = Math.min(Math.max(w, REGION_MIN.w), 1);
  h = Math.min(Math.max(h, REGION_MIN.h), 1);
  x = Math.min(Math.max(x, 0), 1 - w);
  y = Math.min(Math.max(y, 0), 1 - h);

  return roundRegion({ x, y, w, h });
}

/**
 * من إحداثيات العنصر المعروض (0..1) لإحداثيات الفيديو الأصلية.
 * بيراعي object-fit: cover (الجزء المقصوص من الأطراف) والانعكاس في الكاميرا الأمامية.
 */
function regionToVideoRect(region, video, mirrored = false) {
  const vw = video?.videoWidth || 0;
  const vh = video?.videoHeight || 0;
  const ew = video?.clientWidth || 0;
  const eh = video?.clientHeight || 0;
  const full = { sx: 0, sy: 0, sw: vw, sh: vh };

  if (!vw || !vh || !ew || !eh) return full;

  const scale = Math.max(ew / vw, eh / vh);
  const contentW = vw * scale;
  const contentH = vh * scale;
  const offsetX = (ew - contentW) / 2;
  const offsetY = (eh - contentH) / 2;

  const left = region.x * ew - offsetX;
  const top = region.y * eh - offsetY;
  const right = left + region.w * ew;
  const bottom = top + region.h * eh;

  let startX = left / scale;
  let endX = right / scale;
  if (mirrored) {
    startX = (contentW - right) / scale;
    endX = (contentW - left) / scale;
  }

  const sx = Math.max(0, Math.min(vw, Math.min(startX, endX)));
  const ex = Math.max(0, Math.min(vw, Math.max(startX, endX)));
  const sy = Math.max(0, Math.min(vh, top / scale));
  const ey = Math.max(0, Math.min(vh, bottom / scale));

  const rsx = Math.round(sx);
  const rsy = Math.round(sy);
  const rsw = Math.min(Math.round(ex) - rsx, vw - rsx);
  const rsh = Math.min(Math.round(ey) - rsy, vh - rsy);

  if (rsw < 1 || rsh < 1) return full;
  return { sx: rsx, sy: rsy, sw: rsw, sh: rsh };
}

/** حجم الصورة الخارجة: أطول ضلع ≤ 1600px، وأقصر ضلع أقل من 600px يتكبّر */
function cropOutputSize(sw, sh) {
  const longest = Math.max(sw, sh);
  const shortest = Math.min(sw, sh);
  let factor = 1;

  if (shortest < 600) factor = 600 / shortest;
  if (longest * factor > 1600) factor = 1600 / longest;
  if (!Number.isFinite(factor) || factor <= 0) factor = 1;

  return {
    w: Math.max(1, Math.round(sw * factor)),
    h: Math.max(1, Math.round(sh * factor)),
  };
}

/** بصمة بكسل دقيقة لإطار مصغّر — تطابق 100% = نفس الصورة حرفيًا */
function fingerprintVideoFrame(video, canvas, crop = null) {
  if (!video?.videoWidth || !canvas) return "";
  const w = 160;
  const h = 90;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return "";

  if (crop) {
    ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h);
  } else {
    ctx.drawImage(video, 0, 0, w, h);
  }
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
  const captureFeedbackTimerRef = useRef(null);
  const nextCaptureAtRef = useRef(0);
  const facingRef = useRef("environment");

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
  const [captureFlash, setCaptureFlash] = useState(false);
  const [captureStatus, setCaptureStatus] = useState("");
  const [cameraBig, setCameraBig] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(20);
  const [viewRotation, setViewRotation] = useState(0);
  const [overlayMode, setOverlayMode] = useState("translation");
  const [region, setRegion] = useState(readStoredRegion);
  const regionRef = useRef(region);

  const [showSettings, setShowSettings] = useState(false);
  const [models, setModels] = useState(() => readSessionModelStore().models);
  const [presets, setPresets] = useState([]);
  const [keySlots, setKeySlots] = useState(DEFAULT_KEY_SLOTS);
  const [keyDrafts, setKeyDrafts] = useState({});
  const [sessionKeys, setSessionKeys] = useState(readSessionKeys);
  const [activeId, setActiveId] = useState(
    () => readSessionModelStore().activeId
  );
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
  const appRotationStyle =
    viewRotation === 90 || viewRotation === 270
      ? {
          position: "fixed",
          top: "calc((100dvh - 100dvw) / 2)",
          left: "calc((100dvw - 100dvh) / 2)",
          width: "100dvh",
          height: "100dvw",
          minHeight: 0,
          overflowY: "auto",
          transform: `rotate(${viewRotation}deg)`,
          transformOrigin: "center",
        }
      : viewRotation === 180
        ? {
            minHeight: "100dvh",
            transform: "rotate(180deg)",
            transformOrigin: "center",
          }
        : undefined;

  useEffect(() => {
    intervalMsRef.current = interval_;
  }, [interval_]);

  useEffect(() => {
    facingRef.current = facing;
  }, [facing]);

  useEffect(() => {
    // المنطقة بتتحفظ كنِسَب (0..1) عشان تفضل صالحة بعد أي تدوير/تكبير
    regionRef.current = region;
    const timer = window.setTimeout(() => writeStoredRegion(region), 250);
    return () => window.clearTimeout(timer);
  }, [region]);

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
        const localStore = readSessionModelStore();
        setModels(localStore.models);
        setActiveId(localStore.activeId || localStore.models[0]?.id || "");
      }
    } catch (e) {
      const localStore = readSessionModelStore();
      setModels(localStore.models);
      setActiveId(localStore.activeId || localStore.models[0]?.id || "");
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

      const preferredConstraints = {
        video: {
          facingMode: { ideal: preferredFacing },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      };

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(
          preferredConstraints
        );
      } catch (error) {
        if (
          error?.name !== "OverconstrainedError" &&
          error?.name !== "ConstraintNotSatisfiedError"
        ) {
          throw error;
        }

        // إعادة المحاولة بالكاميرا المفضلة بس، والجهاز يختار الدقة
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: preferredFacing } },
          audio: false,
        });
      }

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

      if (captureFeedbackTimerRef.current) {
        clearTimeout(captureFeedbackTimerRef.current);
        captureFeedbackTimerRef.current = null;
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

    if (sessionKey && activeModel?.provider !== "openrouter") {
      throw new Error(
        `الموديل المحدد (${activeModel?.provider || "غير محدد"}) ليس OpenRouter؛ لن يتم إرسال المفتاح إلى /api/vision. اختر موديل OpenRouter أو أضف backend API.`
      );
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

    if (sessionKey && activeModel?.provider !== "openrouter") {
      throw new Error(
        `الموديل المحدد (${activeModel?.provider || "غير محدد"}) ليس OpenRouter؛ لن يتم إرسال المفتاح إلى /api/anthropic-search. اختر موديل OpenRouter أو أضف backend API.`
      );
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
      // الإجابة القديمة تفضل ظاهرة لحد ما الإجابة الجديدة تجهز

      let timeoutId;

      try {
        const prompt = buildAnswerPrompt(q, translationHint);
        const result = await Promise.race([
          callSearch(prompt),
          new Promise((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error("انتهت مهلة طلب الإجابة. حاول مرة أخرى.")),
              30000
            );
          }),
        ]);

        if (requestId !== searchRequestIdRef.current) return;

        if (result.text) {
          // التبويب مش بيتغير تلقائيًا — المستخدم هو اللي يفتح تبويب "الإجابة"
          setSearchInfo(result.text);
        } else {
          setSearchError("لم تصل إجابة. حاول مرة أخرى.");
          pushError("answer", "رد الإجابة فاضي", q);
        }
      } catch (e) {
        if (requestId !== searchRequestIdRef.current) return;

        const msg = e.message || "حصل خطأ أثناء جلب الإجابة.";
        setSearchError(msg);
        pushError("answer", msg, q);
      } finally {
        clearTimeout(timeoutId);
        if (requestId === searchRequestIdRef.current) {
          searchingRef.current = false;
          setSearching(false);
        }
      }
    },
    [callSearch, pushError]
  );

  const captureAndTranslate = useCallback(async () => {
    // عدّاد دائري (عرض فقط): بيعيد ضبط نفسه مع كل محاولة التقاط
    nextCaptureAtRef.current = Date.now() + intervalMsRef.current;
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

    // منطقة الالتقاط المختارة → إحداثيات الفيديو الأصلية (بمراعاة cover والانعكاس)
    const crop = regionToVideoRect(
      regionRef.current,
      video,
      facingRef.current === "user"
    );

    // 1) تطابق صورة 100% مع آخر إطار اتعالج → متبعتش Vision خالص
    const frameHash = fingerprintVideoFrame(video, canvasRef.current, crop);
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
    const output = cropOutputSize(crop.sw, crop.sh);
    canvas.width = output.w;
    canvas.height = output.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("تعذر تجهيز لوحة التقاط الصورة.");
    }

    // بنرسم المنطقة المختارة بس
    ctx.drawImage(
      video,
      crop.sx,
      crop.sy,
      crop.sw,
      crop.sh,
      0,
      0,
      output.w,
      output.h
    );

    // ومضة غالق سريعة + شارة تأكيد أطول من غير ما تعطّل الالتقاط
    if (captureFeedbackTimerRef.current) {
      clearTimeout(captureFeedbackTimerRef.current);
      captureFeedbackTimerRef.current = null;
    }
    setCaptureFlash(true);
    setCaptureStatus("تم التقاط الصورة");
    captureFeedbackTimerRef.current = setTimeout(() => {
      setCaptureFlash(false);
      setCaptureStatus("");
      captureFeedbackTimerRef.current = null;
    }, 1000);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
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

      // النتيجة/الإجابة القديمة بتفضل ظاهرة لحد ما الجديدة تجهز
      setLines(captured);
      searchRequestIdRef.current += 1;
      searchingRef.current = false;
      setSearching(false);
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

  // عدّاد الثواني اللي فاضلة للالتقاط القادم — عرض فقط، مش بيتحكم في المؤقت
  useEffect(() => {
    if (!running) {
      setSecondsLeft(Math.round(interval_ / 1000));
      return;
    }

    const tick = () => {
      const remaining = Math.max(0, nextCaptureAtRef.current - Date.now());
      setSecondsLeft(Math.ceil(remaining / 1000));
    };

    nextCaptureAtRef.current = Date.now() + interval_;
    tick();
    const ticker = window.setInterval(tick, 250);
    return () => window.clearInterval(ticker);
  }, [running, interval_]);

  useEffect(() => {
    if (!running) {
      // إيقاف صريح من المستخدم: منع أي إجابة مجدولة أو جارية من إطار قديم
      captureSeqRef.current += 1;
      searchRequestIdRef.current += 1;
      searchingRef.current = false;
      setSearching(false);

      if (captureFeedbackTimerRef.current) {
        clearTimeout(captureFeedbackTimerRef.current);
        captureFeedbackTimerRef.current = null;
      }
      setCaptureFlash(false);
      setCaptureStatus("");

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

  const retryAnswer = () => {
    if (!primaryLine || searching) return;
    runSearch(primaryLine.original, primaryLine.translation, { force: true });
  };

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
    // الموديلات المضافة في المتصفح بتتفعّل محليًا من غير ما تلمس /api
    const localStore = readSessionModelStore();
    const localModel = localStore.models.find((model) => model.id === id);

    if (localModel) {
      const nextStore = { ...localStore, activeId: id };
      try {
        writeSessionModelStore(nextStore);
        setModels(localStore.models);
        setActiveId(id);
        setSettingsError("");
        return;
      } catch (error) {
        setSettingsError(
          `تعذر حفظ اختيار الموديل في sessionStorage: ${error.message}`
        );
        return;
      }
    }

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
      // استضافة static: نحفظ موديل OpenRouter في جلسة المتصفح بدل ما نفشل
      if (
        draft.provider === "openrouter" &&
        String(sessionKeys.OPENROUTER_API_KEY || "").trim()
      ) {
        const model = {
          id:
            draft.id ||
            `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: draft.name.trim() || draft.model.trim(),
          provider: "openrouter",
          model: draft.model.trim(),
          supportsVision: Boolean(draft.supportsVision),
          hasApiKey: true,
        };

        const nextModels = [
          ...models.filter((item) => item.id !== model.id),
          model,
        ];
        const nextStore = { models: nextModels, activeId: model.id };

        try {
          writeSessionModelStore(nextStore);
          setModels(nextModels);
          setActiveId(model.id);
          setEditing(false);
          setDraft(EMPTY_DRAFT);
          setSettingsError("");
          setSettingsOk("تم حفظ الموديل في جلسة هذا المتصفح.");
          return;
        } catch (storageError) {
          pushError("model-session-storage", storageError.message);
        }
      }

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

  const intervalSeconds = Math.round(interval_ / 1000);
  const answerHint = looksLikeAnswerHint(searchInfo);
  const answerReady = Boolean(searchInfo) && !answerHint;

  return (
    <div
      className="mx-auto flex h-[100dvh] w-full max-w-[560px] flex-col overflow-hidden bg-black text-neutral-100 sm:border-x sm:border-neutral-800"
      dir="rtl"
      style={appRotationStyle}
    >
      {/* 1) الهيدر */}
      <header className="relative z-30 flex shrink-0 items-center justify-between gap-3 border-b border-neutral-800 bg-black px-3 py-2">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-bold leading-tight">مترجم لايف</h1>
          <p className="mt-0.5 truncate text-[10px] leading-tight text-neutral-500">
            إنجليزي / روسي ← عربي
          </p>
        </div>

        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            aria-label="أدوات وإعدادات"
            title="أدوات وإعدادات"
            className="flex h-11 w-11 items-center justify-center rounded-xl border border-neutral-800 bg-neutral-900 text-neutral-300 hover:text-white"
          >
            <Settings size={18} />
          </button>

          {menuOpen && (
            <>
              <button
                type="button"
                aria-label="إغلاق القائمة"
                onClick={() => setMenuOpen(false)}
                className="fixed inset-0 z-30 cursor-default bg-black/60"
              />
              <div
                role="menu"
                className="absolute left-0 top-12 z-40 w-56 overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900 py-1 shadow-2xl"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    startCamera(facing);
                  }}
                  className="flex min-h-[44px] w-full items-center gap-2 px-3 text-sm text-neutral-200 hover:bg-neutral-800"
                >
                  <Camera size={15} className="text-sky-400" />
                  تشغيل الكاميرا
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    flipCamera();
                  }}
                  className="flex min-h-[44px] w-full items-center gap-2 px-3 text-sm text-neutral-200 hover:bg-neutral-800"
                >
                  <RotateCcw size={15} className="text-neutral-400" />
                  قلب الكاميرا
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    forceRecapture();
                  }}
                  disabled={busy}
                  className="flex min-h-[44px] w-full items-center gap-2 px-3 text-sm text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
                >
                  <RefreshCw size={15} className="text-neutral-400" />
                  صوّر من جديد
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    retryAnswer();
                  }}
                  disabled={!primaryLine || searching}
                  className="flex min-h-[44px] w-full items-center gap-2 px-3 text-sm text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
                >
                  <Search size={15} className="text-neutral-400" />
                  حدّث الإجابة
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setViewRotation((angle) => (angle + 90) % 360);
                  }}
                  className="flex min-h-[44px] w-full items-center gap-2 px-3 text-sm text-neutral-200 hover:bg-neutral-800"
                >
                  <RotateCcw size={15} className="text-neutral-400" />
                  تدوير الشاشة
                  <span className="text-[11px] text-neutral-500" dir="ltr">
                    {viewRotation}°
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setShowErrors(true);
                  }}
                  className="flex min-h-[44px] w-full items-center gap-2 px-3 text-sm text-neutral-200 hover:bg-neutral-800"
                >
                  <Bug size={15} className="text-neutral-400" />
                  سجل الأخطاء
                  {errorLog.length > 0 && (
                    <span className="min-w-5 rounded-full bg-red-600 px-1 text-center text-[10px] font-bold text-white">
                      {errorLog.length}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    openSettings();
                  }}
                  className="flex min-h-[44px] w-full items-center gap-2 border-t border-neutral-800 px-3 text-sm text-neutral-200 hover:bg-neutral-800"
                >
                  <Settings size={15} className="text-neutral-400" />
                  الإعدادات
                </button>
                <p
                  className="truncate border-t border-neutral-800 px-3 py-2 text-[10px] text-neutral-500"
                  title={activeModel?.name || ""}
                >
                  الموديل: {activeModel ? activeModel.name : "جارٍ التحميل..."}
                </p>
              </div>
            </>
          )}
        </div>
      </header>

      {/* 2) الكاميرا */}
      <div
        className="relative min-h-[110px] shrink overflow-hidden bg-black"
        style={{
          flexBasis: cameraBig ? "62%" : "34%",
          flexGrow: 0,
          flexShrink: 1,
        }}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="h-full w-full object-cover"
          style={{ transform: facing === "user" ? "scaleX(-1)" : "none" }}
        />
        <canvas ref={canvasRef} className="hidden" />

        {captureFlash && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-20 bg-white/30"
          />
        )}

        <CaptureRegion region={region} onChange={setRegion} />

        {/* الشارة والعداد للعرض فقط — من غير ما ياخدوا لمس فوق منطقة الالتقاط */}
        <div className="pointer-events-none absolute right-2 top-2 z-20">
          {busy ? (
            <span className="flex items-center gap-1.5 rounded-full bg-black px-2.5 py-1.5 text-[11px] font-medium text-amber-300">
              <Loader2 size={12} className="animate-spin" />
              جاري الالتقاط والترجمة…
            </span>
          ) : running ? (
            <span className="flex items-center gap-1.5 rounded-full bg-black px-2.5 py-1.5 text-[11px] font-medium text-white">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
              مباشر
            </span>
          ) : (
            <span className="flex items-center gap-1.5 rounded-full bg-black px-2.5 py-1.5 text-[11px] font-medium text-neutral-400">
              <span className="h-2 w-2 rounded-full bg-neutral-600" />
              متوقف
            </span>
          )}
        </div>

        <div className="pointer-events-none absolute left-2 top-2 z-20">
          <CountdownRing
            seconds={running ? secondsLeft : intervalSeconds}
            total={intervalSeconds}
          />
        </div>

        <div className="absolute inset-x-0 bottom-0 z-20 h-[3px] overflow-hidden bg-amber-500/20">
          {(busy || searching) && (
            <div className="bu-progress-bar h-full w-1/3 rounded-full bg-amber-500" />
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-col border-b border-neutral-800 bg-black px-3">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setCameraBig((value) => !value)}
            aria-pressed={cameraBig}
            className="flex min-h-[44px] items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium text-neutral-400 hover:text-amber-400"
          >
            {cameraBig ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            {cameraBig ? "⤡ تكبير النتيجة" : "⤢ تكبير الكاميرا"}
          </button>

          <div role="group" aria-label="حجم منطقة الالتقاط" className="flex items-center gap-1">
            {REGION_PRESETS.map((preset) => {
              const active = regionsMatch(region, preset.region);
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setRegion(sanitizeRegion(preset.region))}
                  aria-pressed={active}
                  className={`min-h-[44px] rounded-lg px-2.5 text-[11px] font-semibold transition-colors ${
                    active
                      ? "bg-amber-600 text-white"
                      : "border border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200"
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </div>

        <p className="pb-1 text-center text-[10px] leading-relaxed text-neutral-600">
          وجّه السطر جوه الإطار · كل {intervalSeconds} ثانية
        </p>
      </div>

      {/* 3) النتائج */}
      <div className="flex min-h-[120px] flex-1 flex-col bg-neutral-950">
        <div className="shrink-0 px-3 pt-2">
          <div
            role="tablist"
            aria-label="الترجمة والإجابة"
            className="flex gap-1 rounded-xl border border-neutral-800 bg-neutral-900 p-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={overlayMode === "translation"}
              onClick={() => setOverlayMode("translation")}
              className={`flex min-h-[44px] flex-1 items-center justify-center rounded-lg text-sm font-semibold transition-colors ${
                overlayMode === "translation"
                  ? "bg-amber-600 text-white"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              الترجمة
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={overlayMode === "answer"}
              onClick={() => setOverlayMode("answer")}
              className={`flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg text-sm font-semibold transition-colors ${
                overlayMode === "answer"
                  ? "bg-emerald-600 text-white"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              الإجابة
              {answerReady && (
                <span className="rounded-full bg-emerald-500 px-1.5 py-0.5 text-[10px] font-bold text-emerald-950">
                  جاهزة
                </span>
              )}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2 pb-4">
          {overlayMode === "translation" ? (
            primaryLine ? (
              <TranslationCard line={primaryLine} />
            ) : (
              <EmptyState
                icon={<Camera size={18} />}
                title="لسه مفيش ترجمة"
                hint="وجّه الكاميرا على سطر أو سؤال، وبعدين دوس «ابدأ الترجمة اللايف»."
              />
            )
          ) : answerReady ? (
            <AnswerCard text={searchInfo} line={primaryLine} />
          ) : answerHint || searchError ? (
            <section
              role={searchError ? "alert" : "status"}
              className={`rounded-2xl border p-4 ${
                searchError
                  ? "border-red-500/40 bg-neutral-900"
                  : "border-amber-600/40 bg-neutral-900"
              }`}
            >
              {searchError ? (
                <p className="whitespace-pre-line text-sm leading-[1.7] text-red-200 [overflow-wrap:anywhere]">
                  {searchError}
                </p>
              ) : (
                <div className="flex items-start gap-2">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-400" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold leading-[1.7] text-neutral-100">
                      مفيش سؤال واضح في الصورة، قرّب الكاميرا من السؤال
                    </p>
                    <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
                      ثبّت الكاميرا على السؤال لحد ما السطر يبان كامل.
                    </p>
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={retryAnswer}
                disabled={!primaryLine || searching}
                className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-neutral-700 bg-neutral-800 text-sm font-medium text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
              >
                <RefreshCw size={14} />
                {searchError ? "حاول مرة أخرى" : "جرّب تاني"}
              </button>
            </section>
          ) : (
            <EmptyState
              icon={<Check size={18} />}
              title="لسه مفيش إجابة"
              hint="الإجابة هتظهر هنا لما يتعرف على سؤال"
            />
          )}
        </div>
      </div>

      {/* 4) شريط التحكم */}
      <div className="shrink-0 border-t border-neutral-800 bg-black px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => startCamera(facing)}
            aria-label="تشغيل الكاميرا"
            title="تشغيل الكاميرا"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-sky-600 text-white transition-colors hover:bg-sky-500"
          >
            <Camera size={20} />
          </button>

          <button
            type="button"
            onClick={toggleRunning}
            className={`flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-xl text-base font-bold text-white transition-colors ${
              running ? "bg-red-600 hover:bg-red-500" : "bg-amber-600 hover:bg-amber-500"
            }`}
          >
            {running ? (
              <Square size={16} className="fill-current" />
            ) : (
              <Play size={16} className="fill-current" />
            )}
            {running ? "إيقاف" : "ابدأ الترجمة اللايف"}
          </button>
        </div>

        <div
          role="group"
          aria-label="مدة الالتقاط"
          className="mt-2 grid grid-cols-4 gap-1.5"
        >
          {[10000, 20000, 40000, 80000].map((ms) => (
            <button
              key={ms}
              type="button"
              onClick={() => setInterval_(ms)}
              aria-pressed={interval_ === ms}
              className={`min-h-[44px] rounded-lg text-sm font-semibold transition-colors ${
                interval_ === ms
                  ? "bg-amber-600 text-white"
                  : "border border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200"
              }`}
            >
              {ms / 1000}ث
            </button>
          ))}
        </div>

        <p className="mt-1.5 text-center text-[10px] leading-relaxed text-neutral-600">
          النتيجة السابقة تفضل ظاهرة لحد ما الجديدة تجهز
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
