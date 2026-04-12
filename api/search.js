// Vercel Serverless — Google Custom Search + Claude Haiku extraction
// Fallback chain: Google+Claude → Perplexity → Claude-only
//
// Required env vars (at minimum one extraction path):
//   ANTHROPIC_API_KEY      — for Claude Haiku extraction (recommended)
//   GOOGLE_SEARCH_API_KEY  — optional, enables Google search context
//   GOOGLE_SEARCH_CX       — optional, custom search engine ID
//   PERPLEXITY_API_KEY     — optional, fallback only

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'POST only' } });

  const googleKey    = process.env.GOOGLE_SEARCH_API_KEY;
  const googleCx     = process.env.GOOGLE_SEARCH_CX;
  const claudeKey    = process.env.ANTHROPIC_API_KEY;
  const perplexityKey = process.env.PERPLEXITY_API_KEY;

  // Accept either the last user message or a joined conversation.
  // The frontend always sends { messages: [{ role: 'user', content: '...' }] }
  // but some passes (verify) send multi-message arrays.
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const lastUser = [...messages].reverse().find(m => m?.role === 'user');
  const userMessage = lastUser?.content || messages[0]?.content || '';
  if (!userMessage) return res.status(400).json({ error: { message: 'No message in request body' } });

  if (!claudeKey && !perplexityKey) {
    return res.status(500).json({
      error: { message: 'No API keys configured. Set ANTHROPIC_API_KEY (and optionally GOOGLE_SEARCH_API_KEY + GOOGLE_SEARCH_CX) in Vercel env vars.' }
    });
  }

  // ── Try Google Search + Claude Haiku first ──────────────────────────────
  if (googleKey && googleCx && claudeKey) {
    try {
      let searchContext = '';
      try {
        const searchResp = await fetch(
          `https://www.googleapis.com/customsearch/v1?key=${googleKey}&cx=${googleCx}&q=${encodeURIComponent(userMessage)}&num=10`
        );
        if (searchResp.ok) {
          const searchData = await searchResp.json();
          const items = searchData.items || [];
          searchContext = items.map(item =>
            `SOURCE: ${item.link}\nTITLE: ${item.title}\nSNIPPET: ${item.snippet}`
          ).join('\n\n');
        }
      } catch (e) {
        console.error('Google search failed:', e.message);
      }

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

${searchContext ? `Google search results:\n${searchContext}\n` : 'No Google results available — use your training knowledge of halal restaurants.\n'}
Extract halal restaurants. Rules:
1. Include restaurants from the search results above OR ones you know with high confidence exist
2. NEVER fabricate addresses or phone numbers — leave as "" if unknown
3. Skip permanently closed restaurants
4. If temporarily closed, note it
5. Return at least a few results if you can find them

Return ONLY a valid JSON array (no markdown, no backticks, no commentary):
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
          provider: searchContext ? 'google+claude' : 'claude-only',
        });
      } else {
        const errBody = await claudeResp.text();
        console.error('Claude error', claudeResp.status, errBody);
        if (claudeResp.status === 429 || claudeResp.status === 529) {
          return res.status(claudeResp.status).json({
            error: { message: claudeResp.status === 429 ? 'Rate limit — try again in a minute' : 'Anthropic overloaded — try again shortly', type: 'rate_limit' }
          });
        }
        // fall through to backups
      }
    } catch (e) {
      console.error('Google+Claude failed:', e.message);
    }
  }

  // ── Fallback: Perplexity ────────────────────────────────────────────────
  if (perplexityKey) {
    try {
      const response = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${perplexityKey}` },
        body: JSON.stringify({
          model: 'sonar-pro',
          messages: [
            { role: 'system', content: 'Return ONLY a valid JSON array. No markdown. Each object: {"name":"","address":"","cuisine":"","phone":"","notes":"","website":"","gmaps":"","instagram":"","source":""}. Never invent data — leave blank if unknown. Skip permanently closed restaurants.' },
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
        return res.status(response.status).json({ error: { message: data?.error?.message || 'Perplexity error' } });
      }
      const text = data?.choices?.[0]?.message?.content || '[]';
      return res.status(200).json({
        content: [{ type: 'text', text }],
        citations: data?.citations || [],
        provider: 'perplexity',
      });
    } catch (e) {
      console.error('Perplexity failed:', e.message);
    }
  }

  // ── Last resort: Claude alone, no search ────────────────────────────────
  if (claudeKey) {
    try {
      const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4096,
          messages: [{
            role: 'user',
            content: `Find halal restaurants for: "${userMessage}". Return ONLY a JSON array (no markdown): [{"name":"","address":"","cuisine":"","phone":"","notes":"","website":"","gmaps":"","instagram":"","source":""}]`
          }],
        }),
      });
      const data = await claudeResp.json();
      if (!claudeResp.ok) {
        return res.status(claudeResp.status).json({ error: { message: data?.error?.message || 'Claude error' } });
      }
      const text = data.content?.[0]?.text || '[]';
      return res.status(200).json({ content: [{ type: 'text', text }], citations: [], provider: 'claude-only' });
    } catch (e) {
      return res.status(500).json({ error: { message: e.message } });
    }
  }

  return res.status(500).json({ error: { message: 'All extraction paths failed' } });
}
