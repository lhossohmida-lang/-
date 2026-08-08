/* ============================================================
   deku AI Backend — Egg Factory Assistant (OpenRouter)
   ============================================================ */
'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

const PORT = process.env.PORT || 5001;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'cohere/north-mini-code:free';
const FRONTEND_URL = process.env.FRONTEND_URL || `http://localhost:${PORT}`;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const APP_ROOT = path.join(__dirname, '..');

app.use(cors({
  origin: function (origin, callback) {
    // Allow: no origin (curl/server), localhost on any port, 127.0.0.1, Firebase hosting
    if (!origin
      || origin.match(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/)
      || origin.includes('firebaseapp.com')
      || origin.includes('web.app')
    ) {
      callback(null, true);
    } else {
      callback(new Error('CORS not allowed'));
    }
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '50kb' }));

const SYSTEM_PROMPT = `أنت مساعد ذكي متخصص في إدارة مصانع إنتاج البيض. لديك الآن جميع الصلاحيات للتحكم في التطبيق.
إذا طلب منك المستخدم إضافة، تعديل، أو حذف أي بيانات، يمكنك القيام بذلك بكتابة كود JavaScript سيقوم التطبيق بتنفيذه تلقائياً.
يجب أن تضع الكود الذي تريد تنفيذه داخل كتلة كود بالشكل التالي:
\`\`\`javascript
// كود جافاسكريبت هنا
\`\`\`

التطبيق يستخدم مكتبة تخزين محلية DB:
- لقراءة البيانات: \`DB.get('اسم_الجدول')\`
- لحفظ البيانات: \`DB.set('اسم_الجدول', القيمة_الجديدة)\`

الجداول المتاحة: 'daily_logs' (التقارير اليومية)، 'workers' (العمال)، 'settings' (الإعدادات والشركاء)، 'credits' (الديون).
مثال لإضافة عامل:
\`\`\`javascript
let workers = DB.get('workers') || [];
workers.push({ id: Date.now(), name: 'عامل جديد', baseSalary: 30000 });
DB.set('workers', workers);
showToast('تم إضافة العامل بنجاح');
\`\`\`

أجب بالعربية البسيطة. اشرح حساباتك خطوة بخطوة. إذا أعطيت كود جافاسكريبت، فسيتم تنفيذه مباشرة، فلا تكتب أكواداً تجريبية بل أكواداً حقيقية تؤدي الغرض.`;

const MAX_MESSAGE_LENGTH = 2000;

function buildBusinessContextString(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const safeContext = JSON.stringify(ctx, null, 2).slice(0, 50000);
  return `\n\nCURRENT APP DATA CONTEXT (read-only JSON from the user's selected factory; use these exact numbers and do not invent missing data):\n${safeContext}`;
  const lines = [];
  if (ctx.date) lines.push(`التاريخ: ${ctx.date}`);
  if (ctx.layingHens != null) lines.push(`عدد الدجاج البياض: ${ctx.layingHens}`);
  if (ctx.eggsProduced != null) lines.push(`البيض المنتج: ${ctx.eggsProduced}`);
  if (ctx.brokenEggs != null) lines.push(`البيض المكسور: ${ctx.brokenEggs}`);
  if (ctx.eggsSold != null) lines.push(`البيض المباع: ${ctx.eggsSold}`);
  if (ctx.eggStock != null) lines.push(`مخزون البيض: ${ctx.eggStock}`);
  if (ctx.feedCost != null) lines.push(`تكلفة العلف: ${ctx.feedCost} دج`);
  if (ctx.medicineCost != null) lines.push(`تكلفة الأدوية: ${ctx.medicineCost} دج`);
  if (ctx.vitaminsCost != null) lines.push(`تكلفة الفيتامينات: ${ctx.vitaminsCost} دج`);
  if (ctx.laborCost != null) lines.push(`تكلفة العمال: ${ctx.laborCost} دج`);
  if (ctx.electricityCost != null) lines.push(`تكلفة الكهرباء: ${ctx.electricityCost} دج`);
  if (ctx.waterCost != null) lines.push(`تكلفة الماء: ${ctx.waterCost} دج`);
  if (ctx.transportCost != null) lines.push(`تكلفة النقل: ${ctx.transportCost} دج`);
  if (ctx.salesTotal != null) lines.push(`إجمالي المبيعات: ${ctx.salesTotal} دج`);
  if (ctx.feedStockKg != null) lines.push(`مخزون العلف: ${ctx.feedStockKg} كغ`);
  if (lines.length === 0) return '';
  return `\n\nبيانات المصنع الحالية:\n${lines.join('\n')}`;
}

// GET /api/ai/status — Check OpenRouter API status
app.get('/api/ai/status', async (req, res) => {
  try {
    if (!OPENROUTER_API_KEY) {
      return res.json({
        online: false,
        modelInstalled: false,
        model: AI_MODEL,
        error: 'مفتاح OpenRouter API غير موجود. أضفه في ملف .env'
      });
    }

    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}` }
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.status}`);
    }

    const data = await response.json();
    const models = data.data || [];
    const modelFound = models.some(m => m.id === AI_MODEL);

    res.json({
      online: true,
      modelInstalled: modelFound,
      model: AI_MODEL,
      provider: 'OpenRouter',
      ...(modelFound ? {} : { error: `النموذج "${AI_MODEL}" غير متاح على OpenRouter.` })
    });
  } catch (err) {
    console.error('Status check error:', err.message);
    res.json({
      online: false,
      modelInstalled: false,
      model: AI_MODEL,
      error: 'تعذر الاتصال بـ OpenRouter. تحقق من الإنترنت ومفتاح API.'
    });
  }
});

// POST /api/ai/chat — Send message to AI assistant via OpenRouter
app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message, businessContext, history } = req.body;

    if (!OPENROUTER_API_KEY) {
      return res.status(503).json({ error: 'مفتاح OpenRouter API غير موجود. أضفه في ملف .env' });
    }

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'الرسالة فارغة. اكتب سؤالك من فضلك.' });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `السؤال طويل جداً. الحد الأقصى ${MAX_MESSAGE_LENGTH} حرف.` });
    }

    const contextStr = buildBusinessContextString(businessContext);
    const userContent = contextStr
      ? `${contextStr}

تعليمات مهمة جدا:
- البيانات أعلاه مأخوذة مباشرة من التطبيق وقاعدة بيانات المصنع المختار.
- استعمل الأرقام الموجودة في JSON كما هي، ولا تخترع أرقاما من عندك.
- إذا سأل المستخدم عن "اليوم" فاستعمل layerSummary.today.
- إذا سأل عن "هذا الشهر" فاستعمل layerSummary.thisMonth.
- إذا سأل عن المخزون فاستعمل layerSummary.stock.
- إذا سأل عن مصنع اللحم فاستعمل broiler.activeCycle.
- إذا كانت القيمة غير موجودة أو تساوي 0، قل ذلك بوضوح ولا تعوضها بتخمين.

سؤال المستخدم: ${message.trim()}`
      : message.trim();

    const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

    if (Array.isArray(history)) {
      const recentHistory = history.slice(-10);
      for (const h of recentHistory) {
        if (h.role === 'user' || h.role === 'assistant') {
          messages.push({ role: h.role, content: String(h.content || '').slice(0, MAX_MESSAGE_LENGTH) });
        }
      }
    }

    messages.push({ role: 'user', content: userContent });

    const apiRes = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': FRONTEND_URL,
        'X-Title': 'deku - Egg Factory Manager'
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        max_tokens: 1500,
        temperature: 0.2
      })
    });

    if (!apiRes.ok) {
      const errData = await apiRes.json().catch(() => ({}));
      const errMsg = errData.error?.message || `OpenRouter error: ${apiRes.status}`;
      console.error('OpenRouter API Error:', errMsg);

      if (apiRes.status === 401) {
        return res.status(503).json({ error: 'مفتاح API غير صالح. تحقق من المفتاح في ملف .env' });
      }
      if (apiRes.status === 429) {
        return res.status(503).json({ error: 'تم تجاوز حد الاستخدام المجاني. حاول بعد قليل.' });
      }
      if (apiRes.status === 402) {
        return res.status(503).json({ error: 'رصيد OpenRouter غير كافٍ.' });
      }

      throw new Error(errMsg);
    }

    const result = await apiRes.json();
    const reply = result.choices?.[0]?.message?.content || 'لم أستطع توليد رد. حاول مرة أخرى.';
    res.json({ reply });

  } catch (err) {
    console.error('AI Chat Error:', err.message);
    if (err.message?.includes('fetch failed') || err.cause?.code === 'ENOTFOUND') {
      return res.status(503).json({ error: 'لا يوجد اتصال بالإنترنت. تحقق من الشبكة.' });
    }
    res.status(500).json({ error: 'حدث خطأ أثناء التواصل مع الذكاء الاصطناعي. حاول مرة أخرى.' });
  }
});

// Force no-cache for HTML, CSS, JS so changes are always picked up
app.use((req, res, next) => {
  const ext = req.path.split('.').pop().toLowerCase();
  if (['html', 'css', 'js'].includes(ext) || req.path === '/') {
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Surrogate-Control': 'no-store'
    });
  }
  next();
});

app.use(express.static(APP_ROOT, {
  extensions: ['html'],
  index: 'index.html',
  etag: false,
  lastModified: false,
  maxAge: 0
}));

app.get('*', (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache'
  });
  res.sendFile(path.join(APP_ROOT, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ deku AI Server running on http://localhost:${PORT}`);
  console.log(`🤖 Model: ${AI_MODEL}`);
  console.log(`🔑 API Key: ${OPENROUTER_API_KEY ? '✓ configured' : '✗ MISSING'}`);
  console.log(`🌐 Allowed Frontend: ${FRONTEND_URL}`);
});
