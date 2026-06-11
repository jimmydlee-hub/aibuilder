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

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  let prompt = ''
  let system = ''
  try {
    const body = await req.json()
    prompt = String(body?.prompt ?? '').slice(0, 4000)
    system = String(body?.system ?? '').slice(0, 8000)
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!prompt.trim()) {
    return Response.json({ error: 'Missing prompt' }, { status: 400 })
  }

  const fullSystem = system.trim() ? `${BASE_SYSTEM}\n\n${system.trim()}` : BASE_SYSTEM

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: fullSystem,
      messages: [{ role: 'user', content: prompt }],
    })

    const answer = message.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { text: string }).text)
      .join('')
      .trim()

    return Response.json({ answer })
  } catch (err) {
    console.error('Claude request failed:', err)
    return Response.json({ error: 'The assistant is unavailable right now. Please try again.' }, { status: 502 })
  }
}
