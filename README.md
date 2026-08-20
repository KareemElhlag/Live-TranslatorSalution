# مترجم لايف

كاميرا حية تقرأ نص إنجليزي أو روسي وتترجمه للعربية عبر Claude. الفرونت والـ API بيتنشروا مع بعض كخدمة Node واحدة.

## التشغيل المحلي

1. انسخ البيئة:

```bash
cp .env.example .env
```

2. حط مفتاح Anthropic في `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

3. ثبّت وشغّل:

```bash
npm install
npm run dev
```

- الفرونت: http://localhost:5173
- الـ API: http://localhost:3001

الكاميرا تشتغل على `localhost` أو على **HTTPS** بعد الديبلوي. على HTTP عادي المتصفح هيمنعها.

## الإنتاج

```bash
npm install
npm run build
npm start
```

السيرفر بيقدم مجلد `dist` + مسارات `/api/*`. المنصات بتحط `PORT` لوحدها.

### متغيرات البيئة

| المتغير | مطلوب | الوصف |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | نعم | مفتاح Claude |
| `ANTHROPIC_MODEL` | لا | الافتراضي `claude-sonnet-4-6` |
| `PORT` | لا | الافتراضي `3001` |
| `CUSTOM_PROXY_HOSTS` | لا | دومينات الموديل المخصص، مفصولة بفاصلة |

## ديبلوي على Render

1. New → Web Service → وصّل الريبو `Live-TranslatorSalution`
2. Build command: `npm install && npm run build`
3. Start command: `npm start`
4. Environment: `ANTHROPIC_API_KEY`
5. بعد الديبلوي افتح اللينك على HTTPS (موبايل أو لابتوب) واسمح للكاميرا

## ديبلوي على Railway

1. New Project → Deploy from GitHub
2. Build: `npm install && npm run build`
3. Start: `npm start`
4. أضف `ANTHROPIC_API_KEY`

## Docker

```bash
docker build -t live-translator .
docker run -p 3001:3001 -e ANTHROPIC_API_KEY=sk-ant-... live-translator
```

الالتقاط كل 2–3 ثواني بيبعت صورة لـ Claude، فالتكلفة بتزيد لو سيبت الترجمة شغالة مدة طويلة.
