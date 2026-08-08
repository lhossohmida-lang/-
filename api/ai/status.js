/* Vercel Serverless Function — GET /api/ai/status */
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
  const AI_MODEL = process.env.AI_MODEL || 'cohere/north-mini-code:free';

  try {
    if (!OPENROUTER_API_KEY) {
      return res.json({
        online: false,
        modelInstalled: false,
        model: AI_MODEL,
        error: 'مفتاح OpenRouter API غير موجود.'
      });
    }

    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}` }
    });

    if (!response.ok) throw new Error(`OpenRouter API error: ${response.status}`);

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
}
