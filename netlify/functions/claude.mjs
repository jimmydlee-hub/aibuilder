// Backs the on-site AI agent and the AI search box used across builder-generated sites.
// POST { prompt, system } -> { answer }
// Uses Netlify AI Gateway (no API key to manage) via its REST endpoint.

const MODEL = 'claude-sonnet-4-6';

function gateway() {
  const base = process.env.NETLIFY_AI_GATEWAY_BASE_URL;
  const key = process.env.NETLIFY_AI_GATEWAY_KEY;
  return base && key ? { base, key } : null;
}

export default async (req) => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const prompt = String(body.prompt || '').slice(0, 6000).trim();
  const system = String(body.system || '').slice(0, 4000).trim();
  if (!prompt) return Response.json({ error: 'Missing prompt' }, { status: 400 });

  const gw = gateway();
  if (!gw) {
    return Response.json(
      { error: 'AI Gateway is not configured for this site yet.' },
      { status: 503 },
    );
  }

  const defaultSystem =
    'You are a friendly, concise website assistant. Answer the visitor helpfully in a few ' +
    'short sentences. If you do not know something specific about this business, say so plainly ' +
    'and offer to help in another way.';

  try {
    const r = await fetch(`${gw.base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${gw.key}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        system: system || defaultSystem,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!r.ok) {
      return Response.json({ error: 'AI request failed' }, { status: 502 });
    }

    const data = await r.json();
    const answer = (data.content || [])
      .map((c) => c.text || '')
      .join('')
      .trim();

    return Response.json({ answer: answer || 'Sorry, I could not generate a reply just now.' });
  } catch {
    return Response.json({ error: 'AI request failed' }, { status: 502 });
  }
};
