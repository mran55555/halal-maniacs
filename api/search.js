// Vercel Serverless — Firecrawl search + Claude Haiku extraction
// Uses your existing FIRECRAWL_API_KEY for grounded search.
// Falls back to Google Custom Search → Perplexity → Claude-only.
//
// Required env vars (in priority order):
//   FIRECRAWL_API_KEY      — primary search source (recommended)
//   ANTHROPIC_API_KEY      — for Claude Haiku extraction (required)
//   GOOGLE_SEARCH_API_KEY  — optional fallback
//   GOOGLE_SEARCH_CX       — optional fallback
//   PERPLEXITY_API_KEY     — optional fallback

async function claudeExtract(claudeKey, userQuery, searchContext) {
  const prompt = `You are a halal restaurant data extractor.

Search query: "${userQuery}"

${searchContext ? `Real web search results:\n${searchContext}\n` : 'No search results available.\n'}

STRICT RULES:
1. ONLY include restaurants that appear in the search results above with a real source URL
2. Do NOT use your training knowledge to add restaurants — if no real results exist, return []
3. NEVER fabricate addresses, phone numbers, or websites — leave as "" if not in the source
4. Skip permanently closed restaurants
5. The "source" field MUST be the actual URL where the restaurant was found

Return ONLY a valid JSON array (no markdown, no backticks, no commentary):
[{"name":"","address":"","cuisine":"","phone":"","notes":"","website":"","gmaps":"","instagram":"","source":"URL"}]`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': claudeKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    const err = new Error(`Claude ${resp.status}`);
    err.status = resp.status;
    err.body = errBody;
    throw err;
  }
  const data = await resp.json();
  return data.content?.[0]?.text || '[]';
}

async function firecrawlSearch(fcKey, query) {
  // Firecrawl /v1/search returns search results with optional scraped content.
  // Asking for markdown gives Claude richer grounding than just snippets.
  const resp = await fetch('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${fcKey}`,
    },
    body: JSON.stringify({
      query,
      limit: 8,
      scrapeOptions: {
        formats: ['markdown'],
        onlyMainContent: true,
      },
    }),
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    console.error('Firecrawl search failed:', resp.status, errBody);
    const err = new Error(`Firecrawl ${resp.status}: ${errBody.substring(0, 200)}`);
    err.status = resp.status;
    err.source = 'firecrawl';
    throw err;
  }
  const data = await resp.json();
  const items = data?.data || [];
  if (!items.length) return '';
  // Compose grounding context. Cap each result to keep token usage sane.
  return items.map(item => {
    const url = item.url || '';
    const title = item.title || '';
    const content = (item.markdown || item.description || '').substring(0, 1500);
    return `SOURCE: ${url}\nTITLE: ${title}\nCONTENT:\n${content}`;
  }).join('\n\n---\n\n');
}

async function googleSearch(googleKey, googleCx, query) {
  const resp = await fetch(
    `https://www.googleapis.com/customsearch/v1?key=${googleKey}&cx=${googleCx}&q=${encodeURIComponent(query)}&num=10`
  );
  if (!resp.ok) {
    console.error('Google Search failed:', resp.status);
    return null;
  }
  const data = await resp.json();
  const items = data.items || [];
  if (!items.length) return '';
  return items.map(item =>
    `SOURCE: ${item.link}\nTITLE: ${item.title}\nSNIPPET: ${item.snippet}`
  ).join('\n\n');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'POST only' } });

  const fcKey       = process.env.FIRECRAWL_API_KEY;
  const claudeKey   = process.env.ANTHROPIC_API_KEY;
  const googleKey   = process.env.GOOGLE_SEARCH_API_KEY;
  const googleCx    = process.env.GOOGLE_SEARCH_CX;

  console.log('ENV CHECK: firecrawl:', !!fcKey, 'claude:', !!claudeKey, 'google:', !!(googleKey && googleCx));

  if (!claudeKey) {
    return res.status(500).json({
      error: { message: 'No API keys configured. Set ANTHROPIC_API_KEY in Vercel env vars.' }
    });
  }

  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const lastUser = [...messages].reverse().find(m => m?.role === 'user');
  const userMessage = lastUser?.content || messages[0]?.content || '';
  if (!userMessage) return res.status(400).json({ error: { message: 'No message in request body' } });

  // ── Path 1: Firecrawl search + Claude extract (PRIMARY) ────────────────
  let firecrawlError = null;
  if (fcKey && claudeKey) {
    try {
      const searchContext = await firecrawlSearch(fcKey, userMessage);
      if (searchContext) {
        const text = await claudeExtract(claudeKey, userMessage, searchContext);
        return res.status(200).json({
          content: [{ type: 'text', text }],
          citations: [],
          provider: 'firecrawl+claude',
        });
      }
      console.warn('Firecrawl returned no results, falling back');
    } catch (e) {
      console.error('Firecrawl+Claude path failed:', e.message);
      if (e.status === 429 || e.status === 529) {
        return res.status(e.status).json({
          error: { message: e.status === 429 ? 'Rate limit — try again in a minute' : 'Anthropic overloaded — try again shortly', type: 'rate_limit' }
        });
      }
      // Save Firecrawl-specific errors so we can surface them if all paths fail
      if (e.source === 'firecrawl') {
        firecrawlError = `Firecrawl rejected the request (${e.status}). Check FIRECRAWL_API_KEY in Vercel env vars or your Firecrawl quota at firecrawl.dev/dashboard.`;
      }
      // fall through to other providers
    }
  }

  // ── Path 2: Google Custom Search + Claude extract ──────────────────────
  if (googleKey && googleCx && claudeKey) {
    try {
      const searchContext = await googleSearch(googleKey, googleCx, userMessage);
      if (searchContext) {
        const text = await claudeExtract(claudeKey, userMessage, searchContext);
        return res.status(200).json({
          content: [{ type: 'text', text }],
          citations: [],
          provider: 'google+claude',
        });
      }
    } catch (e) {
      console.error('Google+Claude path failed:', e.message);
    }
  }

  // ── Last resort: Claude alone (will hallucinate, warn user) ────────────
  if (claudeKey) {
    try {
      const text = await claudeExtract(claudeKey, userMessage, '');
      return res.status(200).json({
        content: [{ type: 'text', text }],
        citations: [],
        provider: 'claude-only',
        warning: 'No search source available — results may be inaccurate',
      });
    } catch (e) {
      return res.status(500).json({ error: { message: e.message } });
    }
  }

  return res.status(500).json({
    error: { message: firecrawlError || 'All extraction paths failed' }
  });
}
