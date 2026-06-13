import type { Context } from '@netlify/functions'
import Anthropic from '@anthropic-ai/sdk'

// AI Gateway injects ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL at runtime,
// so the default constructor works without any manual configuration.
const anthropic = new Anthropic()

const DEFAULT_SYSTEM =
  'You are GrantsGPT, a helpful assistant on the GrantsGPT website. ' +
  'Answer visitor questions about grants, funding, and the site clearly and concisely. ' +
  'If you are unsure, say so and suggest contacting the team.'

export default async (req: Request, context: Context) => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  let prompt = ''
  let system = ''
  try {
    const body = await req.json()
    prompt = (body?.prompt ?? '').toString().trim()
    system = (body?.system ?? '').toString().trim()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!prompt) {
    return Response.json({ error: 'Missing "prompt"' }, { status: 400 })
  }

  try {
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      system: system || DEFAULT_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    })

    const answer = message.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { text: string }).text)
      .join('')
      .trim()

    return Response.json({ answer })
  } catch (err) {
    console.error('claude function error:', err)
    return Response.json(
      { error: 'The assistant is temporarily unavailable. Please try again.' },
      { status: 502 },
    )
  }
}
