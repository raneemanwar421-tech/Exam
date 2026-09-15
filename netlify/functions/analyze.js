// Netlify Function — مجاني بالكامل، بديل عن Cloudflare Pages Function
// بيستخدم Gemini API المجاني من Google بدل Anthropic المدفوع
// الرابط النهائي بعد النشر: /.netlify/functions/analyze
// وملف netlify.toml بيحوّل /api/analyze لهذا المسار تلقائياً، حتى index.html
// يشتغل من غير أي تعديل إضافي.

const PROMPT = [
  "You are reading a photographed page of a school exam. The page mixes Arabic instructions/headers with French exam content (or is fully Arabic).",
  "Extract the page content as a JSON array of blocks describing the page top to bottom, in original reading order. Output ONLY the raw JSON array — no explanation, no markdown code fences, no extra text before or after.",
  "Use these block shapes (short keys), and ONLY these:",
  '{"t":"heading","x":"<full boxed page title text, without the circled number>"}',
  '{"t":"section","x":"<a bold section header line, e.g. \\"I- Compréhension écrite :\\" or \\"A. Répondez par...\\" or a page label like \\"الصفحة الثانية\\">"}',
  '{"t":"subhead","x":"<a secondary bold instruction line>"}',
  '{"t":"paragraph","x":"<a body paragraph, verbatim>"}',
  '{"t":"source","x":"<a short line like a website/source or a note such as \\"يتبع في الصفحة الثانية\\">"}',
  '{"t":"question","n":"<number as string>","x":"<question text; use ……… for blanks>","p":"<points exactly as written, e.g. \\"(10 Pts.)\\", or \\"\\" if none>"}',
  '{"t":"options","o":["a. ...","b. ...","c. ...","d. ..."]}',
  '{"t":"table","r":[["a","..."],["b","..."]]}',
  '{"t":"blank","x":"<a line of numbered blanks for ordering answers, e.g. \\"1-…… 2-…… 3-……\\">"}',
  '{"t":"closing","x":"<a final centered line if present, e.g. \\"انتهت الأسئلة\\">"}',
  "Rules: copy every piece of text EXACTLY as written (same language, punctuation, quotes «»), no translation, no summarizing, no adding anything not visible on the page. Keep JSON compact (minimal whitespace)."
].join("\n");

// قائمة نماذج تُجرَّب بالترتيب: إذا تقاعد نموذج أو تغيّر اسمه (404) أو تجاوز
// الحصة المجانية (429) ينتقل تلقائياً للنموذج التالي بدل فشل التحليل كاملاً.
const MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite-preview",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash"
];

exports.handler = async function (event) {
  try {
    if (event.httpMethod !== "POST") {
      return json({ error: "Method not allowed" }, 405, { allow: "POST" });
    }

    const APP_SECRET = process.env.APP_SECRET || "";
    if (APP_SECRET && event.headers["x-app-secret"] !== APP_SECRET) {
      return json({ error: "غير مصرّح." }, 401);
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_) {
      return json({ error: "بيانات الطلب غير صالحة." }, 400);
    }
    const { image, mediaType } = body;
    if (!image) {
      return json({ error: "لم يتم إرسال صورة." }, 400);
    }
    if (typeof image !== "string" || image.length > 15 * 1024 * 1024) {
      return json({ error: "حجم الصورة كبير جداً. اختر صورة أقل من 10 ميغابايت تقريباً." }, 413);
    }
    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    const safeMediaType = allowedTypes.includes(mediaType) ? mediaType : "image/jpeg";
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return json({ error: "مفتاح Gemini API غير مضبوط على Netlify (GEMINI_API_KEY)." }, 500);
    }

    // Netlify's synchronous functions are killed around the 10s mark on the
    // free tier; abort a bit earlier so the client gets a clear, friendly
    // error instead of a bare network failure / hung "جارٍ التحليل…" state.
    // نمنح كل نموذج مهلة قصيرة، وننتقل للنموذج التالي عند الأعطاب المؤقتة.
    const RETRYABLE = new Set([404, 429, 500, 502, 503, 504]);
    let geminiRes = null;
    let data = null;
    let lastMessage = "خدمة التحليل غير متاحة حالياً.";

    for (const model of MODELS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8500);
      try {
        geminiRes = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": GEMINI_API_KEY
          },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { inline_data: { mime_type: safeMediaType, data: image } },
                  { text: PROMPT }
                ]
              }
            ],
            // Ask Gemini to return raw JSON directly instead of relying on
            // the client stripping ```json fences — fewer parse failures.
            generationConfig: { responseMimeType: "application/json" }
          })
        });
      } catch (fetchErr) {
        clearTimeout(timeout);
        if (fetchErr && fetchErr.name === "AbortError") {
          lastMessage = "استغرق تحليل الصورة وقتاً طويلاً. جرّب صورة أوضح أو أصغر حجماً.";
          continue; // جرّب النموذج التالي
        }
        throw fetchErr;
      }
      clearTimeout(timeout);

      try {
        data = await geminiRes.json();
      } catch (_) {
        data = null;
      }

      if (geminiRes.ok) break; // نجح التحليل بهذا النموذج

      lastMessage = (data && data.error && data.error.message) || ("HTTP " + geminiRes.status);
      if (!RETRYABLE.has(geminiRes.status)) {
        // خطأ غير قابل للتجاوز (مثلاً مفتاح API خاطئ) — لا فائدة من تجربة غيره
        return json({ error: lastMessage }, geminiRes.status);
      }
      data = null; // جرّب النموذج التالي في القائمة
    }

    if (!geminiRes || !geminiRes.ok) {
      return json({ error: lastMessage }, 502);
    }

    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const text = parts.map(p => p.text).filter(Boolean).join("\n");

    // نرجّعها بنفس شكل رد Anthropic (content: [{type:'text', text}])
    // حتى كود الواجهة (index.html) يشتغل من غير أي تعديل إضافي
    if (!text) {
      return json({ error: "لم تُرجع خدمة التحليل نصاً قابلاً للقراءة." }, 502);
    }
    return json({ content: [{ type: "text", text }] }, 200);

  } catch (err) {
    return json({ error: err.message || "خطأ غير متوقع." }, 500);
  }
};

function json(obj, status, extraHeaders = {}) {
  return {
    statusCode: status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders
    },
    body: JSON.stringify(obj)
  };
}
