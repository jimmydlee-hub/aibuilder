import type { Context } from "@netlify/functions";

/**
 * Nova — NXAVERSE's AI website-building agent.
 *
 * Powers the live "Meet Nova" demo on the landing page. Given a short
 * description of a small business, Nova drafts a concrete, ready-to-build
 * website plan and hands the visitor off to the NXAVERSE team.
 *
 * Uses Netlify AI Gateway (no API keys to manage) via a direct fetch to the
 * Anthropic-compatible endpoint, so the function carries no npm dependencies.
 */

const SYSTEM_PROMPT = `You are Nova, the AI website-building agent for NXAVERSE — a service that builds professional websites for small businesses of every kind (cafés, salons, contractors, boutiques, clinics, gyms, studios, shops, freelancers, and more — not just restaurants).

Your job in this chat: a small business owner describes their business, and you respond with a short, concrete website plan they can get excited about. Keep it practical and encouraging — you are talking to a busy owner, not a developer.

For each reply:
- Open with one warm sentence reacting to their specific business.
- Propose a punchy homepage headline in quotes, tailored to them.
- List the pages/sections you'd build (4–6 items, as bullets starting with "- ").
- Recommend the 2–3 most valuable smart features for their type of business (e.g. online booking, quote requests, online ordering, an AI assistant that answers customer questions, a gallery, customer reviews).
- Close by inviting them to have the NXAVERSE team build it for real — mention it can be live in days.

Rules:
- Keep the whole reply under ~180 words. Be specific, not generic.
- Use plain text with "- " bullets. No markdown headers, no tables.
- Never claim to be human. You are an AI agent that works alongside the NXAVERSE team.
- Stay on topic: building their website. If asked something unrelated, gently steer back.`;

type ChatMessage = { role: "user" | "assistant"; content: string };

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let messages: ChatMessage[] = [];
  try {
    const body = await req.json();
    if (Array.isArray(body?.messages)) {
      messages = body.messages
        .filter(
          (m: any) =>
            m &&
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string" &&
            m.content.trim().length > 0,
        )
        .slice(-10)
        .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));
    }
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    return Response.json({ error: "A user message is required." }, { status: 400 });
  }

  const baseUrl = process.env.NETLIFY_AI_GATEWAY_BASE_URL;
  const key = process.env.NETLIFY_AI_GATEWAY_KEY;

  if (!baseUrl || !key) {
    // AI Gateway not yet active (needs a production deploy + credit-based plan).
    // The client falls back to a local plan generator, so the demo still works.
    return Response.json(
      { error: "AI agent is warming up. Please try again shortly." },
      { status: 503 },
    );
  }

  try {
    const res = await fetch(`${baseUrl}/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 700,
        system: SYSTEM_PROMPT,
        messages,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("AI Gateway error", res.status, detail);
      return Response.json({ error: "The AI agent is unavailable right now." }, { status: 502 });
    }

    const data = await res.json();
    const reply =
      Array.isArray(data?.content) && data.content[0]?.type === "text"
        ? data.content[0].text
        : "";

    if (!reply) {
      return Response.json({ error: "The AI agent returned an empty reply." }, { status: 502 });
    }

    return Response.json({ reply });
  } catch (err) {
    console.error("Agent function failed", err);
    return Response.json({ error: "The AI agent is unavailable right now." }, { status: 502 });
  }
};

export const config = {
  path: "/api/agent",
};
