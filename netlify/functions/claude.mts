import type { Context } from '@netlify/functions'
import Anthropic from '@anthropic-ai/sdk'

// AI Gateway injects ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL automatically in
// production, so the zero-config constructor works without managing keys.
const anthropic = new Anthropic()

const DEFAULT_SYSTEM =
  'You are a friendly, concise assistant embedded on a website. ' +
  'Answer visitor questions helpfully and accurately. If you are unsure, ' +
  'say so plainly. Keep replies short and easy to read.'

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return Response.json({ answer: 'Method not allowed.' }, { status: 405 })
  }

  let prompt = ''
  let system = ''
  try {
    const body = await req.json()
    prompt = (body?.prompt || '').toString().slice(0, 8000)
    system = (body?.system || '').toString().slice(0, 8000)
  } catch {
    return Response.json({ answer: 'Sorry, I could not read that request.' }, { status: 400 })
  }

  if (!prompt.trim()) {
    return Response.json({ answer: 'Please type a question first.' }, { status: 400 })
  }

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      system: system.trim() || DEFAULT_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    })

    const answer = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()

    return Response.json({ answer: answer || 'I did not have a reply for that — try rephrasing?' })
  } catch (err) {
    console.error('claude function error:', err)
    return Response.json(
      { answer: 'The assistant is temporarily unavailable. Please try again in a moment.' },
      { status: 502 },
    )
  }
}
