// netlify/functions/chat.mts
//
// A Claude-powered assistant for U.S. federal grants. It uses Anthropic tool
// use to query the public grants.gov REST API for real opportunities, then
// streams a structured answer back to the browser as newline-delimited JSON.

import type { Config, Context } from '@netlify/functions'
import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic()

const MODEL = 'claude-sonnet-4-6'
const GRANTS_API = 'https://api.grants.gov/v1/api'
const DETAIL_URL = (id: string | number) =>
  `https://www.grants.gov/search-results-detail/${id}`

// ---------------------------------------------------------------------------
// grants.gov helpers
// ---------------------------------------------------------------------------

function stripHtml(input?: string | null): string {
  if (!input) return ''
  return input
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function grantsPost(path: string, body: unknown) {
  const res = await fetch(`${GRANTS_API}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`grants.gov ${path} responded ${res.status}`)
  }
  return res.json()
}

async function searchGrants(args: {
  keyword?: string
  oppStatuses?: string
  rows?: number
  eligibilities?: string
  agencies?: string
}) {
  const payload = {
    keyword: args.keyword ?? '',
    oppStatuses: args.oppStatuses || 'forecasted|posted',
    rows: Math.min(Math.max(args.rows ?? 8, 1), 15),
    eligibilities: args.eligibilities ?? '',
    agencies: args.agencies ?? '',
  }
  const json = await grantsPost('search2', payload)
  const data = json?.data ?? {}
  const hits = (data.oppHits ?? []).map((h: any) => ({
    opportunityId: h.id,
    opportunityNumber: h.number,
    title: h.title,
    agency: h.agency,
    agencyCode: h.agencyCode,
    status: h.oppStatus,
    openDate: h.openDate,
    closeDate: h.closeDate,
    cfda: h.cfdaList,
  }))
  return {
    hitCount: data.hitCount ?? hits.length,
    returned: hits.length,
    opportunities: hits,
  }
}

async function getGrantDetails(opportunityId: string | number) {
  const json = await grantsPost('fetchOpportunity', {
    opportunityId: Number(opportunityId),
  })
  const d = json?.data ?? {}
  const s = d.synopsis ?? {}

  // Application packages contain the downloadable forms/documents an
  // applicant must complete and submit.
  const packages = (d.opportunityPkgs?.opportunityPkg ?? d.opportunityPkgs ?? [])
  const pkgArray = Array.isArray(packages) ? packages : packages ? [packages] : []
  const applicationDocuments = pkgArray
    .map((p: any) => ({
      name: p.competitionTitle || p.competitionId || p.packageId,
      openDate: p.openingDate,
      closeDate: p.closingDate,
      electronicRequired: p.electronicSubmission,
    }))
    .slice(0, 12)

  // Attached files (NOFO / full announcement PDFs, etc.).
  const folders = d.synopsisAttachmentFolders ?? []
  const attachments: { name: string; url?: string }[] = []
  for (const folder of Array.isArray(folders) ? folders : []) {
    for (const att of folder?.synopsisAttachments ?? []) {
      attachments.push({
        name: att.fileName || att.fileDescription,
        url: att.id ? `${GRANTS_API}/fetchOpportunityDocument?id=${att.id}` : undefined,
      })
    }
  }

  return {
    opportunityId: d.id ?? opportunityId,
    title: d.opportunityTitle,
    opportunityNumber: d.opportunityNumber,
    status: d.docType,
    cfdaNumbers: (d.cfdas ?? []).map((c: any) => `${c.cfdaNumber} ${c.programTitle ?? ''}`.trim()),
    synopsis: stripHtml(s.synopsisDesc),
    agency: {
      name: s.agencyName,
      contactName: s.agencyContactName,
      contactEmail: s.agencyContactEmail,
      contactPhone: s.agencyContactPhone || s.agencyPhone,
    },
    deadlines: {
      posted: s.postingDateStr,
      closes: s.responseDateStr,
      closeDescription: stripHtml(s.responseDateDesc),
      archives: s.archiveDateStr,
    },
    award: {
      ceiling: s.awardCeilingFormatted,
      floor: s.awardFloorFormatted,
      estimatedTotalProgramFunding: s.estimatedFundingFormatted,
      expectedNumberOfAwards: s.numberOfAwards,
      costSharingRequired: s.costSharing,
    },
    eligibility: {
      applicantTypes: (s.applicantTypes ?? []).map((a: any) => a.description),
      additionalInfo: stripHtml(s.applicantEligibilityDesc),
    },
    fundingInstruments: (s.fundingInstruments ?? []).map((f: any) => f.description),
    fundingCategories: (s.fundingActivityCategories ?? []).map((f: any) => f.description),
    relatedProgramLink: s.fundingDescLinkUrl,
    applicationDocuments,
    attachments: attachments.slice(0, 12),
    applyAndViewUrl: DETAIL_URL(d.id ?? opportunityId),
  }
}

// ---------------------------------------------------------------------------
// Claude tools
// ---------------------------------------------------------------------------

const tools: Anthropic.Tool[] = [
  {
    name: 'search_grants',
    description:
      'Search grants.gov for federal funding opportunities by keyword. Returns a list of matching opportunities with their IDs, titles, agencies and key dates. Use this first to find relevant grants, then call get_grant_details for the most relevant ones.',
    input_schema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: 'Search terms, e.g. "rural broadband", "STEM education", "clean energy small business".',
        },
        oppStatuses: {
          type: 'string',
          description:
            'Pipe-separated statuses to include. Options: posted, forecasted, closed, archived. Default "forecasted|posted" (currently open or upcoming). Use "posted" for only currently-open opportunities.',
        },
        rows: { type: 'number', description: 'Number of results to return (1-15, default 8).' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'get_grant_details',
    description:
      'Fetch the full detail record for a single grants.gov opportunity by its numeric opportunityId. Returns the synopsis, eligibility, award amounts, deadlines, required application documents, administering agency and the apply/view URL.',
    input_schema: {
      type: 'object',
      properties: {
        opportunityId: {
          type: 'string',
          description: 'The numeric opportunity ID returned by search_grants (the "opportunityId" field).',
        },
      },
      required: ['opportunityId'],
    },
  },
]

async function runTool(name: string, input: any): Promise<string> {
  try {
    if (name === 'search_grants') {
      return JSON.stringify(await searchGrants(input ?? {}))
    }
    if (name === 'get_grant_details') {
      return JSON.stringify(await getGrantDetails(input?.opportunityId))
    }
    return JSON.stringify({ error: `Unknown tool: ${name}` })
  } catch (err: any) {
    return JSON.stringify({ error: err?.message ?? 'tool failed' })
  }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM = `You are the Grants.gov Assistant, a knowledgeable and friendly guide to U.S. federal grant opportunities. You are powered by Claude and you answer using live data from grants.gov.

Your job is to help people find federal grants and understand exactly what they need to apply.

HOW TO WORK
- For any question about finding or understanding a grant, ALWAYS use the search_grants tool to find real, current opportunities, then call get_grant_details on the most relevant one (or a few) before answering. Never invent grant numbers, deadlines, dollar amounts, or links.
- If the user is vague, make a reasonable search and, if helpful, ask one short clarifying question after showing what you found.
- If a search returns nothing useful, broaden the keywords and try again before giving up.

HOW TO ANSWER ABOUT A SPECIFIC GRANT
When you describe a specific opportunity, present it clearly using this structure (use Markdown headings and bullets). Omit a section only if the data is genuinely unavailable:

## [Grant Title]
A one-line plain-English description, plus the opportunity number and administering agency.

### Synopsis
A short, readable summary of what the grant funds and who it is for.

### Eligible organizations
Bullet list of who can apply (applicant types) and any key eligibility notes.

### Award amount
Award ceiling, floor, estimated total program funding, and expected number of awards. Note if cost-sharing is required.

### Key deadlines
Posted date, application close date (with any special notes), and archive date.

### Document checklist
A simple checklist (use "- [ ]" Markdown checkboxes) of the documents and forms an applicant needs to prepare and submit. Base this on the application packages and attachments from the detail record; if specific forms are not listed, give the standard set typically required (e.g. SF-424, project narrative, budget and budget justification, etc.) and clearly say these are typical requirements to confirm in the official announcement.

### Where to apply
The grants.gov apply/view link, the administering agency, agency contact (name, email, phone) when available, and any related program link. Format the apply link as a Markdown link.

STYLE
- Be warm, concise and practical. Use Markdown. Prefer short paragraphs and scannable bullets.
- Always include the grants.gov apply/view link for any specific opportunity you discuss.
- When you list several opportunities, give each a brief blurb with its agency, close date and a link, then invite the user to pick one for full details.
- Remind users, briefly and only when relevant, to verify details in the official announcement before applying.
- Today's date context: use the deadlines from the data; do not assume the current date beyond what the data implies.`

// ---------------------------------------------------------------------------
// Handler — streaming agentic loop
// ---------------------------------------------------------------------------

type ChatMessage = { role: 'user' | 'assistant'; content: string }

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  let body: { messages?: ChatMessage[] }
  try {
    body = await req.json()
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }

  const history = (body.messages ?? [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content?.trim())
    .slice(-12)

  if (history.length === 0) {
    return new Response('No messages provided', { status: 400 })
  }

  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }))

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))

      try {
        let safety = 0
        while (safety++ < 6) {
          const llm = anthropic.messages.stream({
            model: MODEL,
            max_tokens: 2048,
            system: SYSTEM,
            tools,
            messages,
          })

          for await (const event of llm) {
            if (
              event.type === 'content_block_delta' &&
              event.delta.type === 'text_delta'
            ) {
              send({ type: 'text', text: event.delta.text })
            }
          }

          const final = await llm.finalMessage()
          messages.push({ role: 'assistant', content: final.content })

          if (final.stop_reason !== 'tool_use') break

          const toolResults: Anthropic.ToolResultBlockParam[] = []
          for (const block of final.content) {
            if (block.type !== 'tool_use') continue
            const label =
              block.name === 'search_grants'
                ? `Searching grants.gov for "${(block.input as any)?.keyword ?? ''}"`
                : 'Reading the full grant details from grants.gov'
            send({ type: 'status', text: label })
            const result = await runTool(block.name, block.input)
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result,
            })
          }
          messages.push({ role: 'user', content: toolResults })
        }

        send({ type: 'done' })
      } catch (err: any) {
        send({
          type: 'error',
          text:
            'The assistant ran into a problem reaching grants.gov or the model. Please try again. (' +
            (err?.message ?? 'unknown error') +
            ')',
        })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

export const config: Config = {
  path: '/api/chat',
}
