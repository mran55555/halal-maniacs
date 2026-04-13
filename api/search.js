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

RULES:
1. Extract restaurants mentioned in the search results above. Use the source URL, title, and description to identify restaurant names.
2. If a restaurant name is mentioned in a result title or description, include it — even if the address isn't fully spelled out.
3. NEVER fabricate addresses or phone numbers — leave as "" if not in the source. It is OK to have just a name.
4. The "source" field MUST be the actual URL where the restaurant was found.
5. Skip permanently closed restaurants and skip non-restaurants (grocery stores, mosques, schools).
6. If the search results clearly contain no halal restaurants at all, return [].
7. Do NOT invent restaurants from your training data.

Return ONLY a valid JSON array (no markdown code fences, no backticks, no commentary):
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
  // Plain Firecrawl search — no per-result scraping (faster, more reliable).
  // We rely on title + description for grounding; Claude can extract from snippets.
  const resp = await fetch('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${fcKey}`,
    },
    body: JSON.stringify({
      query,
      limit: 10,
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
  // Firecrawl returns results in data.data (array of {url, title, description, ...})
  const items = data?.data || [];
  console.log(`Firecrawl returned ${items.length} results for query: "${query}"`);
  if (!items.length) return '';
  return items.map(item => {
    const url = item.url || '';
    const title = item.title || '';
    const description = item.description || item.markdown || '';
    return `SOURCE: ${url}\nTITLE: ${title}\nDESCRIPTION: ${description}`;
  }).join('\n\n');
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

  // The frontend sends a long prompt template; extract just the search intent.
  // Pattern: "Search the web for: <query>\n\nCRITICAL RULES..." — grab the first line after the colon.
  let searchQuery = userMessage;
  const m = userMessage.match(/Search the web for:\s*([^\n]+)/i);
  if (m && m[1]) {
    searchQuery = m[1].trim();
  } else {
    // Fallback: take first line, strip trailing punctuation, cap at 200 chars
    searchQuery = userMessage.split('\n')[0].trim().substring(0, 200);
  }
  console.log(`Search query (cleaned): "${searchQuery}"`);

  // ── Path 1: Firecrawl search + Claude extract (PRIMARY) ────────────────
  let firecrawlError = null;
  if (fcKey && claudeKey) {
    try {
      const searchContext = await firecrawlSearch(fcKey, searchQuery);
      if (searchContext) {
        const text = await claudeExtract(claudeKey, searchQuery, searchContext);
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
      if (e.source === 'firecrawl') {
        firecrawlError = `Firecrawl rejected the request (${e.status}). Check FIRECRAWL_API_KEY in Vercel env vars or your Firecrawl quota at firecrawl.dev/dashboard.`;
      }
    }
  }

  // ── Path 2: Google Custom Search + Claude extract ──────────────────────
  if (googleKey && googleCx && claudeKey) {
    try {
      const searchContext = await googleSearch(googleKey, googleCx, searchQuery);
      if (searchContext) {
        const text = await claudeExtract(claudeKey, searchQuery, searchContext);
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
      const text = await claudeExtract(claudeKey, searchQuery, '');
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
