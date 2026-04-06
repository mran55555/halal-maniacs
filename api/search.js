// Vercel Serverless Function — Perplexity search with anti-hallucination settings

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'PERPLEXITY_API_KEY not configured' } });

  try {
    const userMessage = req.body?.messages?.[0]?.content || '';

    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [
          {
            role: 'system',
            content: `You are a factual halal restaurant lookup tool. You MUST follow these rules strictly:

1. ONLY return restaurants you found in ACTUAL web search results from this query. 
2. NEVER make up, guess, or invent any restaurant name, address, or phone number.
3. If you cannot find a piece of info (phone, address), leave it as an empty string "". Do NOT guess.
4. Every restaurant you return MUST appear in your search results with a real source URL.
5. Return FEWER results if needed — accuracy matters more than quantity.
6. Double-check that addresses are real and match the city being searched.
7. If you only find 2-3 real results, return only those 2-3. Do NOT pad with made-up entries.
8. SKIP any restaurant that is permanently closed or no longer exists.
9. If a restaurant is temporarily closed, include it but add "Temporarily closed" in the notes field.

Return ONLY a valid JSON array. No markdown, no backticks, no explanation before or after.
Each object: {"name":"","address":"","cuisine":"","phone":"","notes":"","website":"","gmaps":"","instagram":"","source":"where you found it"}`
          },
          {
            role: 'user',
            content: userMessage
          }
        ],
        max_tokens: 4096,
        temperature: 0,
        return_citations: true,
        search_domain_filter: null,
      }),
    });

    if (response.status === 429) {
      return res.status(429).json({ error: { message: 'Rate limit — try again in a minute', type: 'rate_limit' } });
    }

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: { message: data?.error?.message || 'API error', type: 'api_error' } });
    }

    const text = data?.choices?.[0]?.message?.content || '[]';
    const citations = data?.citations || [];

    // Return in Anthropic-compatible format + citations
    return res.status(200).json({
      content: [{ type: 'text', text }],
      citations: citations
    });

  } catch (e) {
    return res.status(500).json({ error: { message: e.message || 'Search failed', type: 'server_error' } });
  }
}
