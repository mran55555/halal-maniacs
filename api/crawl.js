// Vercel Serverless — Firecrawl scrapes + Claude Haiku extracts
// Replaced Perplexity with Google Custom Search + Claude Haiku

async function claudeExtract(claudeKey, prompt) {
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
  if (!resp.ok) throw new Error(`Claude error ${resp.status}`);
  const data = await resp.json();
  return data.content?.[0]?.text || '[]';
}

async function googleSearch(googleKey, googleCx, query) {
  try {
    const resp = await fetch(
      `https://www.googleapis.com/customsearch/v1?key=${googleKey}&cx=${googleCx}&q=${encodeURIComponent(query)}&num=10`
    );
    if (!resp.ok) return '';
    const data = await resp.json();
    return (data.items || []).map(item =>
      `SOURCE: ${item.link}\nTITLE: ${item.title}\nSNIPPET: ${item.snippet}`
    ).join('\n\n');
  } catch(e) {
    return '';
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const fcKey     = process.env.FIRECRAWL_API_KEY;
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const googleKey = process.env.GOOGLE_SEARCH_API_KEY;
  const googleCx  = process.env.GOOGLE_SEARCH_CX;
  const pplxKey   = process.env.PERPLEXITY_API_KEY; // fallback only
  console.log('ENV CHECK: fc:', !!fcKey, 'claude:', !!claudeKey, 'google:', !!googleKey, 'pplx:', !!pplxKey);

  if (!fcKey) return res.status(500).json({ error: { message: 'FIRECRAWL_API_KEY not configured' } });
  if (!claudeKey && !pplxKey) return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY not configured' } });

  const { city, state, action, pass } = req.body;
  const JSON_FMT = 'Return ONLY a valid JSON array, no markdown, no backticks. Each object: {"name":"","address":"full street address","cuisine":"","phone":"(XXX) XXX-XXXX","website":"","notes":"","source":""}';

  // ── Fetch cities ──────────────────────────────────────────────────────────
  if (action === 'cities') {
    const stateSlug = state.replace(/\s+/g, '_');
    let allCities = [];

    // Step 1: Firecrawl Wikipedia
    const wikiUrls = [
      `https://en.wikipedia.org/wiki/List_of_municipalities_in_${stateSlug}`,
      `https://en.wikipedia.org/wiki/List_of_cities_in_${stateSlug}`,
      `https://en.wikipedia.org/wiki/List_of_cities_and_towns_in_${stateSlug}`,
    ];

    for (const url of wikiUrls) {
      if (allCities.length > 50) break;
      try {
        const fcResp = await fetch('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${fcKey}` },
          body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true, timeout: 30000 }),
        });
        if (fcResp.ok) {
          const md = (await fcResp.json())?.data?.markdown || '';
          if (md.length > 500) {
            const skipWords = new Set(['United States','Census','Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan','Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada','New Hampshire','New Jersey','New Mexico','New York','North Carolina','North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina','South Dakota','Tennessee','Texas','Utah','Vermont','Virginia','Washington','West Virginia','Wisconsin','Wyoming','County','Township','Borough','Village','Wikipedia','References','External links','See also','Notes','Sources','List of','Demographics']);
            for (const match of md.matchAll(/\[([A-Z][a-zA-Z\s\.\-']+)\]\([^)]*wiki[^)]*\)/g)) {
              const name = match[1].trim();
              if (name.length > 1 && name.length < 40 && !skipWords.has(name) && !name.includes('County') && !name.match(/^\d/)) {
                if (!allCities.includes(name)) allCities.push(name);
              }
            }
            for (const match of md.matchAll(/\|\s*\[?([A-Z][a-zA-Z\s\.\-']{1,35})\]?\s*(?:\([^)]*\))?\s*\|/g)) {
              const name = match[1].trim();
              if (name.length > 1 && name.length < 40 && !skipWords.has(name) && !name.includes('County') && !name.match(/^\d/) && !name.match(/^(The|List|Table|Map|See|Population|Area|Type|Name|City|Town|Municipality|Rank|Status)/i)) {
                if (!allCities.includes(name)) allCities.push(name);
              }
            }
          }
        }
      } catch (e) { /* try next */ }
    }

    // Step 2: Demographics site
    if (allCities.length < 100) {
      try {
        const demoUrl = `https://www.${state.toLowerCase().replace(/\s+/g, '')}-demographics.com/cities_by_population`;
        const fcResp = await fetch('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${fcKey}` },
          body: JSON.stringify({ url: demoUrl, formats: ['markdown'], onlyMainContent: true, timeout: 30000 }),
        });
        if (fcResp.ok) {
          const md = (await fcResp.json())?.data?.markdown || '';
          for (const match of md.matchAll(/\[([A-Z][a-zA-Z\s\.\-']+)\]/g)) {
            const name = match[1].trim().replace(/\s+(city|town|village|CDP)$/i, '');
            if (name.length > 1 && name.length < 40 && !allCities.includes(name)) allCities.push(name);
          }
        }
      } catch (e) { /* skip */ }
    }

    // Step 3: Claude fills gaps if still low (replaces Perplexity)
    if (allCities.length < 100 && claudeKey) {
      try {
        const already = allCities.slice(0, 50).join(', ');
        const text = await claudeExtract(claudeKey,
          `List EVERY incorporated city and town in ${state}, USA that is NOT in this list: [${already}].
Return ONLY a JSON array of city name strings. No markdown, no backticks. Example: ["Portland","Eugene","Salem"]`
        );
        const m = text.match(/\[[\s\S]*\]/);
        if (m) {
          const more = JSON.parse(m[0]).filter(c => typeof c === 'string' && c.trim());
          for (const c of more) { if (!allCities.includes(c)) allCities.push(c); }
        }
      } catch(e) { /* skip */ }
    }

    return res.status(200).json({
      cities: JSON.stringify(allCities),
      method: 'firecrawl+claude',
      count: allCities.length
    });
  }

  if (!city || !state) return res.status(400).json({ error: { message: 'city and state required' } });

  const passNum   = pass || 0;
  const enc       = encodeURIComponent;
  const cityState = `${city}, ${state}`;

  // Scrape targets
  const scrapeTargets = [
    { url: `https://www.zabihah.com/search?l=${enc(cityState)}&r=30&t=r`, label: 'Zabihah' },
    { url: `https://www.yelp.com/search?find_desc=halal+restaurants&find_loc=${enc(cityState)}`, label: 'Yelp' },
    { url: `https://www.google.com/maps/search/halal+restaurants+${enc(city + '+' + state)}`, label: 'Google Maps' },
    { url: `https://www.tripadvisor.com/Search?q=halal+restaurants+${enc(city + '+' + state)}`, label: 'TripAdvisor' },
    { url: `https://www.doordash.com/search/store/${enc('halal ' + city)}`, label: 'DoorDash' },
    { url: `https://www.ubereats.com/search?q=${enc('halal ' + city)}`, label: 'UberEats' },
    { url: `https://www.google.com/search?q=${enc('halal restaurants ' + city + ' ' + state + ' site:instagram.com OR site:facebook.com')}`, label: 'Social Media' },
    { url: `https://www.google.com/search?q=${enc('halal food ' + city + ' ' + state + ' review')}`, label: 'Google Reviews' },
    { url: `https://www.google.com/search?q=${enc('halal restaurant ' + city + ' ' + state + ' hidden gem OR new OR underrated')}`, label: 'Hidden Gems' },
    { url: `https://www.zabihah.com/search?q=${enc(city + ' ' + state)}`, label: 'Zabihah Location' },
  ];

  const target = scrapeTargets[passNum % scrapeTargets.length];
  let scrapedText = '';
  let method = `firecrawl-${target.label.toLowerCase().replace(/\s+/g, '-')}`;

  // Step 1: Firecrawl scrape
  try {
    const fcResp = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${fcKey}` },
      body: JSON.stringify({ url: target.url, formats: ['markdown'], onlyMainContent: true, timeout: 30000 }),
    });
    if (fcResp.status === 429) {
      return res.status(429).json({ error: { message: `Firecrawl rate limit on ${target.label}`, type: 'rate_limit' } });
    }
    if (fcResp.ok) {
      scrapedText = (await fcResp.json())?.data?.markdown || '';
    }
  } catch (e) { /* fall through */ }

  // Step 2: Backup — Firecrawl Google if primary failed
  if (scrapedText.length < 100) {
    try {
      const backupUrl = `https://www.google.com/search?q=${enc('halal restaurants ' + city + ' ' + state)}`;
      const fcResp = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${fcKey}` },
        body: JSON.stringify({ url: backupUrl, formats: ['markdown'], onlyMainContent: true, timeout: 30000 }),
      });
      if (fcResp.ok) {
        scrapedText = (await fcResp.json())?.data?.markdown || '';
        method = 'firecrawl-google-backup';
      }
    } catch (e) { /* skip */ }
  }

  // Step 3: If still no content — use Google Custom Search API as fallback
  if (scrapedText.length < 100 && googleKey && googleCx) {
    scrapedText = await googleSearch(googleKey, googleCx, `halal restaurants ${cityState}`);
    method = 'google-custom-search';
  }

  // Step 4: Extract with Claude Haiku (replaces Perplexity)
  console.log('DEBUG: claudeKey exists:', !!claudeKey, 'pplxKey exists:', !!pplxKey, 'scrapedText length:', scrapedText.length);
  if (claudeKey) {
    try {
      let prompt;
      if (scrapedText.length >= 100) {
        prompt = `Extract halal restaurants for ${cityState} from this content scraped from ${target.label}:

${scrapedText.substring(0, 4000)}

Rules:
- ONLY include restaurants in ${cityState}
- NEVER make up addresses or phone numbers
- Skip permanently closed restaurants
- If temporarily closed add "Temporarily closed" in notes
- Phone format: (XXX) XXX-XXXX

${JSON_FMT}`;
      } else {
        prompt = `List halal restaurants currently open in ${cityState}.
Only include restaurants you know with high confidence exist there.
For each one include full street address and phone number.
${JSON_FMT}`;
      }

      const text = await claudeExtract(claudeKey, prompt);
      return res.status(200).json({
        content: [{ type: 'text', text }],
        method, pass: passNum,
      });
    } catch (e) {
      // Fall through to Perplexity backup
    }
  }

  // Step 5: Perplexity as last resort fallback
  if (pplxKey) {
    try {
      const resp = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${pplxKey}` },
        body: JSON.stringify({
          model: 'sonar-pro', temperature: 0, max_tokens: 4096,
          messages: [
            { role: 'system', content: `ONLY return restaurants from actual search results. SKIP permanently closed. ${JSON_FMT}` },
            { role: 'user', content: `Halal restaurants in ${cityState}:\n\n${scrapedText.substring(0, 4000)}\n\n${JSON_FMT}` }
          ],
        }),
      });
      const data = await resp.json();
      return res.status(200).json({
        content: [{ type: 'text', text: data?.choices?.[0]?.message?.content || '[]' }],
        method: 'perplexity-fallback', pass: passNum,
      });
    } catch (e) {
      return res.status(500).json({ error: { message: e.message } });
    }
  }

  return res.status(500).json({ error: { message: 'No extraction API available' } });
}
