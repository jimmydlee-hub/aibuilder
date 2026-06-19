// Analyzes a visitor's existing website and recommends AI enhancements.
// POST { url } -> { ok, site:{name,url}, evaluation, enhancements[], build }
//   evaluation:   { summary, strengths[], opportunities[] }
//   enhancements: [{ icon, title, desc }]   (AI features they can add)
//   build:        a seed the builder applies on one click — { name, accent, accent2,
//                 agent:{name,emoji,greeting,system}, search:{placeholder,examples[]}, blocks[] }
//                 blocks use the builder's own block schema (hero/gallery/unique/how/
//                 testimonials/contact/cta).
//
// Uses Netlify AI Gateway (no API key to manage) via its REST endpoint.

const MODEL = 'claude-sonnet-4-6';
const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 600_000;
const MAX_TEXT_CHARS = 8000;

function gateway() {
  const base = process.env.NETLIFY_AI_GATEWAY_BASE_URL;
  const key = process.env.NETLIFY_AI_GATEWAY_KEY;
  return base && key ? { base, key } : null;
}

// Normalize user input into a safe http(s) URL, or return null.
function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  // Basic SSRF hygiene: refuse local / private targets.
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host) ||
    !host.includes('.')
  ) {
    return null;
  }
  return u;
}

function extractContent(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i,
  );
  const headings = [...html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 12);

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_CHARS);

  return {
    title: titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '',
    description: descMatch ? descMatch[1].trim() : '',
    headings,
    text,
  };
}

async function fetchSite(u) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(u.toString(), {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'NetlifyAIWebsiteBuilder/1.0 (+site analyzer)' },
    });
    if (!r.ok) return null;
    const type = r.headers.get('content-type') || '';
    if (!type.includes('html') && !type.includes('text')) return null;
    const buf = await r.arrayBuffer();
    return new TextDecoder('utf-8').decode(buf.slice(0, MAX_HTML_BYTES));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonLoose(s) {
  try {
    return JSON.parse(s);
  } catch {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a !== -1 && b > a) {
      try {
        return JSON.parse(s.slice(a, b + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function buildPrompt(host, content) {
  return `You are a website strategist for a tool that adds AI features to small-business websites.
The tool can add: an on-page AI assistant chatbot (powered by Claude), an AI answer/search box in
the hero, and AI-written marketing sections.

Analyze the website "${host}" using the extracted content below, then return ONLY a JSON object
(no markdown, no commentary) with EXACTLY this shape:

{
  "name": "the brand/business name",
  "accent": "#RRGGBB primary brand color guess",
  "accent2": "#RRGGBB secondary/lighter accent",
  "evaluation": {
    "summary": "2-3 sentences: what the site is about and overall impression",
    "strengths": ["3 short bullet strings"],
    "opportunities": ["3 short bullet strings about what's missing, esp. around AI/engagement"]
  },
  "enhancements": [
    { "icon": "one emoji", "title": "short feature name", "desc": "one sentence on the value to this specific business" }
  ],
  "agent": {
    "name": "a friendly first name for the assistant",
    "emoji": "one emoji avatar",
    "greeting": "a one-line opening message in the brand's voice",
    "system": "2-3 sentences instructing the assistant how to behave for THIS business (role, tone, what it knows)"
  },
  "search": {
    "placeholder": "an inviting placeholder for the AI answer box, tailored to this business",
    "examples": ["3 example questions a visitor of THIS site might ask"]
  },
  "blocks": [
    // 4-6 sections to seed an AI-enhanced version of their site, in order.
    // The FIRST block MUST be type "hero". Use ONLY these shapes:
    // {"type":"hero","pill":"...","headline":"...","sub":"..."}
    // {"type":"how","ey":"...","title":"...","items":[{"emoji":"x","title":"...","desc":"..."},{...},{...}]}
    // {"type":"unique","badge":"...","title":"...","emoji":"x","desc":"...","points":["...","...","..."],"cta":"..."}
    // {"type":"testimonials","ey":"...","title":"...","items":[{"quote":"...","name":"...","role":"..."}, x3]}
    // {"type":"gallery","ey":"...","title":"...","sub":"...","items":[{"title":"...","caption":"..."}, x3]}
    // {"type":"contact","ey":"...","title":"...","sub":"...","button":"..."}
    // {"type":"cta","headline":"...","sub":"...","button":"..."}
  ]
}

Provide 4 enhancements. Make every string specific to this business — no placeholders like "your headline here".

--- EXTRACTED SITE CONTENT ---
Title: ${content.title || '(none)'}
Meta description: ${content.description || '(none)'}
Headings: ${content.headings.join(' | ') || '(none)'}
Body text (truncated): ${content.text || '(none)'}`;
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

  const u = normalizeUrl(body.url);
  if (!u) {
    return Response.json(
      { error: 'Please enter a valid public website address.' },
      { status: 400 },
    );
  }

  const gw = gateway();
  if (!gw) {
    return Response.json(
      { error: 'AI Gateway is not configured for this site yet.' },
      { status: 503 },
    );
  }

  const html = await fetchSite(u);
  if (!html) {
    return Response.json(
      { error: "Could not load that website. Check the address, or it may block automated visits." },
      { status: 422 },
    );
  }

  const content = extractContent(html);

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
        max_tokens: 2200,
        messages: [{ role: 'user', content: buildPrompt(u.hostname, content) }],
      }),
    });

    if (!r.ok) return Response.json({ error: 'AI request failed' }, { status: 502 });

    const data = await r.json();
    const raw = (data.content || []).map((c) => c.text || '').join('').trim();
    const parsed = parseJsonLoose(raw);
    if (!parsed || !parsed.evaluation) {
      return Response.json({ error: 'Could not interpret the analysis.' }, { status: 502 });
    }

    const build = {
      name: parsed.name || u.hostname,
      accent: /^#[0-9a-f]{6}$/i.test(parsed.accent || '') ? parsed.accent : undefined,
      accent2: /^#[0-9a-f]{6}$/i.test(parsed.accent2 || '') ? parsed.accent2 : undefined,
      agent: parsed.agent || undefined,
      search: parsed.search || undefined,
      blocks: Array.isArray(parsed.blocks) ? parsed.blocks : [],
    };

    return Response.json({
      ok: true,
      site: { name: parsed.name || u.hostname, url: u.toString() },
      evaluation: parsed.evaluation,
      enhancements: Array.isArray(parsed.enhancements) ? parsed.enhancements : [],
      build,
    });
  } catch {
    return Response.json({ error: 'AI request failed' }, { status: 502 });
  }
};
