/* Vercel Serverless Function — POST /api/ai/chat */

const SYSTEM_PROMPT = `أنت مساعد ذكي متخصص في إدارة مصانع إنتاج البيض. وظيفتك مساعدة صاحب المصنع في حساب الربح، الخسارة، الإنتاج اليومي، عدد البيض، عدد الدجاج البياض، نسبة الإنتاج، البيض المكسور، العلف، الأدوية، الفيتامينات، العمال، الكهرباء، الماء، النقل، المخزون، الفواتير، الزبائن، وتقديم نصائح عملية لتحسين الإنتاج وتقليل الخسارة.

أجب بالعربية البسيطة أو الدارجة الجزائرية حسب لغة المستخدم. لا تخترع أرقامًا غير موجودة. إذا احتجت بيانات، اطلبها من المستخدم بوضوح. عندما تعطي حسابات، اشرح العملية خطوة بخطوة وباختصار. لا تقم بتعديل أو حذف بيانات التطبيق، فقط قدّم اقتراحات وتحليلات.

طريقة الحسابات:
- نسبة الإنتاج = عدد البيض المنتج / عدد الدجاج البياض × 100
- البيض الصالح = البيض المنتج - البيض المكسور
- عدد الكرتونات = البيض الصالح / 30
- المصاريف الكلية = العلف + الأدوية + الفيتامينات + العمال + الكهرباء + الماء + النقل + أي مصاريف أخرى
- الربح الصافي = مجموع المبيعات - المصاريف الكلية
- نسبة الربح = الربح الصافي / المصاريف الكلية × 100
- تكلفة البيضة الواحدة = المصاريف الكلية / عدد البيض الصالح
- سعر البيع مع هامش ربح 20% = تكلفة البيضة × 1.20
- تكلفة الكرتونة = تكلفة البيضة × 30`;

const MAX_MESSAGE_LENGTH = 2000;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

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

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
  const AI_MODEL = process.env.AI_MODEL || 'cohere/north-mini-code:free';

  try {
    const { message, businessContext, history } = req.body;

    if (!OPENROUTER_API_KEY) {
      return res.status(503).json({ error: 'مفتاح OpenRouter API غير موجود.' });
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
        'HTTP-Referer': 'https://deku-egg-factory.vercel.app',
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

      if (apiRes.status === 401) return res.status(503).json({ error: 'مفتاح API غير صالح.' });
      if (apiRes.status === 429) return res.status(503).json({ error: 'تم تجاوز حد الاستخدام. حاول بعد قليل.' });
      if (apiRes.status === 402) return res.status(503).json({ error: 'رصيد OpenRouter غير كافٍ.' });
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
}
