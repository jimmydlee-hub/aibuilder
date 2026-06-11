import type { Context } from '@netlify/functions'
import { createHash } from 'node:crypto'

// One-click publish: takes the site HTML produced in the browser and deploys it to a
// real Netlify site using the Netlify API. The first publish creates a fresh site; later
// publishes reuse the returned siteId so the same live URL updates in place.
const API = 'https://api.netlify.com/api/v1'

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

  const token = Netlify.env.get('NETLIFY_AUTH_TOKEN')
  if (!token) {
    return json(
      {
        error:
          'One-click publishing is not configured on this builder. Use “Export site” to download your index.html, then drag it onto app.netlify.com/drop.',
      },
      503,
    )
  }

  let html = ''
  let siteId = ''
  try {
    const body = await req.json()
    html = String(body?.html ?? '')
    siteId = String(body?.siteId ?? '').trim()
  } catch {
    return json({ error: 'Invalid request body' }, 400)
  }

  if (!html.trim()) {
    return json({ error: 'Missing site content' }, 400)
  }

  const auth = { Authorization: `Bearer ${token}` }

  try {
    // 1. Reuse an existing site, or create a brand-new one on the first publish.
    if (!siteId) {
      const res = await fetch(`${API}/sites`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) throw new Error(`create site failed (${res.status})`)
      const site = await res.json()
      siteId = site.id
    }

    // 2. Open a deploy declaring the files by SHA1 digest.
    const bytes = Buffer.from(html, 'utf8')
    const sha = createHash('sha1').update(bytes).digest('hex')
    const depRes = await fetch(`${API}/sites/${siteId}/deploys`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ files: { '/index.html': sha } }),
    })
    if (!depRes.ok) throw new Error(`create deploy failed (${depRes.status})`)
    const deploy = await depRes.json()

    // 3. Upload the file content for any digest Netlify says it still needs.
    const required: string[] = Array.isArray(deploy.required) ? deploy.required : []
    if (required.includes(sha)) {
      const up = await fetch(`${API}/deploys/${deploy.id}/files/index.html`, {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/octet-stream' },
        body: bytes,
      })
      if (!up.ok) throw new Error(`upload failed (${up.status})`)
    }

    // 4. Resolve the stable site URL to hand back to the builder.
    let url = deploy.ssl_url || deploy.url || ''
    try {
      const s = await fetch(`${API}/sites/${siteId}`, { headers: auth })
      if (s.ok) {
        const sj = await s.json()
        url = sj.ssl_url || sj.url || url
      }
    } catch {
      /* fall back to the deploy URL */
    }

    return json({ url, siteId, deployId: deploy.id })
  } catch (err) {
    console.error('Publish failed:', err)
    return json(
      { error: 'Publishing failed. Please try again, or use “Export site” to download your site.' },
      502,
    )
  }
}
