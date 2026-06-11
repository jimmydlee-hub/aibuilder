import type { Context } from '@netlify/functions'
import Anthropic from '@anthropic-ai/sdk'

// AI Gateway injects ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL automatically on Netlify,
// so the default constructor works with no key management.
const anthropic = new Anthropic()

// Keeps every assistant — search bar and chat widget — warm, concise, and on-topic
// even before the site owner writes their own personality/instructions.
const BASE_SYSTEM =
  'You are a friendly assistant embedded on a small business website. ' +
  'Help visitors with questions about the business and its products or services. ' +
  'Keep answers short, warm, and genuinely helpful. ' +
  'If you do not know a specific detail, say so honestly and suggest using the contact form or contact details on the page.'

// Published sites are static and call this builder-hosted endpoint from their own
// origin, so the assistant works on every site without each one shipping a function.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  })
}

export default async (req: Request, _context: Context) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  let prompt = ''
  let system = ''
  let raw = false
  try {
    const body = await req.json()
    prompt = String(body?.prompt ?? '').slice(0, 8000)
    system = String(body?.system ?? '').slice(0, 8000)
    raw = Boolean(body?.raw)
  } catch {
    return json({ error: 'Invalid request body' }, 400)
  }

  if (!prompt.trim()) {
    return json({ error: 'Missing prompt' }, 400)
  }

  // `raw` skips the customer-facing assistant persona — used by the builder's
  // "write my website copy" generator, which needs a copywriter system prompt only.
  let fullSystem: string
  if (raw) {
    fullSystem = system.trim() || BASE_SYSTEM
  } else {
    fullSystem = system.trim() ? `${BASE_SYSTEM}\n\n${system.trim()}` : BASE_SYSTEM
  }

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: fullSystem,
      messages: [{ role: 'user', content: prompt }],
    })

    const answer = message.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { text: string }).text)
      .join('')
      .trim()

    return json({ answer })
  } catch (err) {
    console.error('Claude request failed:', err)
    return json({ error: 'The assistant is unavailable right now. Please try again.' }, 502)
  }
}
