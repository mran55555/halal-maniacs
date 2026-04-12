// Vercel Serverless — Google Custom Search + Claude Haiku extraction
// Replaces Perplexity sonar-pro at ~90% lower cost
// Uses: Google Custom Search API (free 100/day, $5/1000 after)
//       Claude Haiku for extraction (already cheapest option)
//
// Required env vars:
//   GOOGLE_SEARCH_API_KEY  — from console.cloud.google.com
//   GOOGLE_SEARCH_CX       — Custom Search Engine ID from cse.google.com
//   ANTHROPIC_API_KEY      — for Claude Haiku extraction

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const googleKey = process.env.GOOGLE_SEARCH_API_KEY;
  const googleCx  = process.env.GOOGLE_SEARCH_CX;
  const claudeKey = process.env.ANTHROPIC_API_KEY;

  // Fallback to Perplexity if Google not configured
  const perplexityKey = process.env.PERPLEXITY_API_KEY;

  const userMessage = req.body?.messages?.[0]?.content || '';
  if (!userMessage) return res.status(400).json({ error: 'No message' });

  // ── Try Google Search + Claude Haiku first ──────────────────────────────
  if (googleKey && googleCx && claudeKey) {
    try {
      // Step 1: Google Custom Search
      const searchResp = await fetch(
        `https://www.googleapis.com/customsearch/v1?key=${googleKey}&cx=${googleCx}&q=${encodeURIComponent(userMessage)}&num=10`
      );

      let searchContext = '';
      if (searchResp.ok) {
        const searchData = await searchResp.json();
        const items = searchData.items || [];
        searchContext = items.map(item =>
          `SOURCE: ${item.link}\nTITLE: ${item.title}\nSNIPPET: ${item.snippet}`
        ).join('\n\n');
      }

      // Step 2: Claude Haiku extracts structured restaurant data
      const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': claudeKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4096,
          messages: [{
            role: 'user',
            content: `You are a halal restaurant data extractor. 

Search query: "${userMessage}"

Google search results:
${searchContext || 'No Google results available — use your knowledge.'}

Extract ALL halal restaurants mentioned. Rules:
1. ONLY include restaurants that appear in the search results above OR that you know with high confidence exist
2. NEVER make up addresses or phone numbers — leave as "" if unknown
3. Every restaurant must have a real street address
4. Skip permanently closed restaurants
5. If temporarily closed, add "Temporarily closed" in notes

Return ONLY a valid JSON array, no markdown, no backticks:
[{"name":"","address":"full street address","cuisine":"","phone":"","notes":"","website":"","gmaps":"","instagram":"","source":"URL where found"}]`
          }],
        }),
      });

      if (claudeResp.ok) {
        const claudeData = await claudeResp.json();
        const text = claudeData.content?.[0]?.text || '[]';
        return res.status(200).json({
          content: [{ type: 'text', text }],
          citations: [],
          provider: 'google+claude',
        });
      }
    } catch (e) {
      console.error('Google+Claude failed:', e.message);
      // Fall through to Perplexity backup
    }
  }

  // ── Fallback: Perplexity (if configured) ───────────────────────────────
  if (perplexityKey) {
    try {
      const response = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${perplexityKey}`,
        },
        body: JSON.stringify({
          model: 'sonar-pro',
          messages: [
            {
              role: 'system',
              content: `You are a factual halal restaurant lookup tool. You MUST follow these rules strictly:
1. ONLY return restaurants you found in ACTUAL web search results.
2. NEVER make up any restaurant name, address, or phone number.
3. If you cannot find a piece of info, leave it as "". Do NOT guess.
4. SKIP any permanently closed restaurant.
5. Return ONLY a valid JSON array. No markdown, no backticks.
Each object: {"name":"","address":"","cuisine":"","phone":"","notes":"","website":"","gmaps":"","instagram":"","source":""}`
            },
            { role: 'user', content: userMessage }
          ],
          max_tokens: 4096,
          temperature: 0,
          return_citations: true,
        }),
      });

      if (response.status === 429) {
        return res.status(429).json({ error: { message: 'Rate limit — try again in a minute', type: 'rate_limit' } });
      }

      const data = await response.json();
      if (!response.ok) {
        return res.status(response.status).json({ error: { message: data?.error?.message || 'API error' } });
      }

      const text = data?.choices?.[0]?.message?.content || '[]';
      return res.status(200).json({
        content: [{ type: 'text', text }],
        citations: data?.citations || [],
        provider: 'perplexity',
      });
    } catch (e) {
      return res.status(500).json({ error: { message: e.message || 'Search failed' } });
    }
  }

  // ── Claude only (no search) ─────────────────────────────────────────────
  if (claudeKey) {
    try {
      const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': claudeKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4096,
          messages: [{
            role: 'user',
            content: `Find halal restaurants for: "${userMessage}". Return ONLY a JSON array: [{"name":"","address":"","cuisine":"","phone":"","notes":"","website":"","gmaps":"","instagram":"","source":""}]`
          }],
        }),
      });

      const data = await claudeResp.json();
      const text = data.content?.[0]?.text || '[]';
      return res.status(200).json({
        content: [{ type: 'text', text }],
        citations: [],
        provider: 'claude-only',
      });
    } catch (e) {
      return res.status(500).json({ error: { message: e.message } });
    }
  }

  return res.status(500).json({ error: { message: 'No API keys configured' } });
}
