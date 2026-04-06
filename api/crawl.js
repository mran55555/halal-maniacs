// Vercel Serverless — 10 Firecrawl passes per city, Perplexity extracts

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const fcKey = process.env.FIRECRAWL_API_KEY;
  const pplxKey = process.env.PERPLEXITY_API_KEY;
  if (!fcKey) return res.status(500).json({ error: { message: 'FIRECRAWL_API_KEY not configured' } });
  if (!pplxKey) return res.status(500).json({ error: { message: 'PERPLEXITY_API_KEY not configured' } });

  const { city, state, action, pass } = req.body;

  // ── Fetch cities ───────────────────
  if (action === 'cities') {
    const stateSlug = state.replace(/\s+/g, '_');
    let allCities = [];

    // Step 1: Firecrawl scrape Wikipedia's complete municipality list
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
          const fcData = await fcResp.json();
          const md = fcData?.data?.markdown || '';
          if (md.length > 500) {
            // Extract city/town names from Wikipedia markdown links like [CityName](...)
            const linkMatches = md.matchAll(/\[([A-Z][a-zA-Z\s\.\-']+)\]\([^)]*wiki[^)]*\)/g);
            const skipWords = new Set(['United States','Census','Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan','Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada','New Hampshire','New Jersey','New Mexico','New York','North Carolina','North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina','South Dakota','Tennessee','Texas','Utah','Vermont','Virginia','Washington','West Virginia','Wisconsin','Wyoming','County','Township','Borough','Village','Census Bureau','United States Census','American Community Survey','Census-designated place','Metropolitan area','Wikipedia','References','External links','See also','Notes','Sources','List of','Demographics']);
            for (const match of linkMatches) {
              const name = match[1].trim();
              if (name.length > 1 && name.length < 40 && !skipWords.has(name) && !name.includes('County') && !name.includes('Township') && !name.includes('census') && !name.match(/^\d/) && !name.match(/^(The|List|Table|Map|See|Note|Source|Reference|External)/)) {
                if (!allCities.includes(name)) allCities.push(name);
              }
            }
            // Also try table row patterns: | CityName | or | [CityName](...) |
            const tableMatches = md.matchAll(/\|\s*\[?([A-Z][a-zA-Z\s\.\-']{1,35})\]?\s*(?:\([^)]*\))?\s*\|/g);
            for (const match of tableMatches) {
              const name = match[1].trim();
              if (name.length > 1 && name.length < 40 && !skipWords.has(name) && !name.includes('County') && !name.includes('Township') && !name.match(/^\d/) && !name.match(/^(The|List|Table|Map|See|Population|Area|Type|Name|City|Town|Municipality|Rank|Status)/i)) {
                if (!allCities.includes(name)) allCities.push(name);
              }
            }
          }
        }
      } catch (e) { /* try next URL */ }
    }

    // Step 2: Also scrape a demographics site for more coverage
    if (allCities.length < 100) {
      try {
        const demoUrl = `https://www.${state.toLowerCase().replace(/\s+/g, '')}-demographics.com/cities_by_population`;
        const fcResp = await fetch('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${fcKey}` },
          body: JSON.stringify({ url: demoUrl, formats: ['markdown'], onlyMainContent: true, timeout: 30000 }),
        });
        if (fcResp.ok) {
          const fcData = await fcResp.json();
          const md = fcData?.data?.markdown || '';
          const matches = md.matchAll(/\[([A-Z][a-zA-Z\s\.\-']+)\]/g);
          for (const match of matches) {
            const name = match[1].trim().replace(/\s+(city|town|village|CDP)$/i, '');
            if (name.length > 1 && name.length < 40 && !allCities.includes(name)) allCities.push(name);
          }
        }
      } catch (e) { /* skip */ }
    }

    // Step 3: If still low, Perplexity fills in the gaps
    if (allCities.length < 100) {
      try {
        const already = allCities.slice(0, 50).join(', ');
        const resp = await fetch('https://api.perplexity.ai/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${pplxKey}` },
          body: JSON.stringify({
            model: 'sonar-pro', temperature: 0, max_tokens: 8192,
            messages: [
              { role: 'system', content: 'Return ONLY a JSON array of city/town name strings. No markdown, no backticks.' },
              { role: 'user', content: `List EVERY incorporated city and town in ${state}, USA that is NOT in this list: [${already}]. I need ALL remaining municipalities including tiny towns. Return JSON array of strings.` }
            ],
          }),
        });
        const data = await resp.json();
        const text = data?.choices?.[0]?.message?.content || '[]';
        const m = text.match(/\[[\s\S]*\]/);
        if (m) {
          try {
            const more = JSON.parse(m[0]).filter(c => typeof c === 'string' && c.trim());
            for (const c of more) { if (!allCities.includes(c)) allCities.push(c); }
          } catch(e) {}
        }
      } catch (e) { /* skip */ }
    }

    if (allCities.length > 0) {
      return res.status(200).json({ cities: JSON.stringify(allCities), method: 'firecrawl-extract', count: allCities.length });
    }

    return res.status(200).json({ cities: '[]', error: { message: 'Could not fetch cities' } });
  }

  if (!city || !state) return res.status(400).json({ error: { message: 'city and state required' } });

  const passNum = pass || 0;
  const enc = encodeURIComponent;
  const cityState = `${city}, ${state}`;
  const q = enc(`halal restaurants in ${city} ${state}`);

  // 10 different real sources to scrape per city
  const scrapeTargets = [
    { url: `https://www.zabihah.com/search?q=${enc(city + ' ' + state)}`, label: 'Zabihah' },
    { url: `https://www.yelp.com/search?find_desc=halal+restaurants&find_loc=${enc(cityState)}`, label: 'Yelp' },
    { url: `https://www.google.com/maps/search/halal+restaurants+${enc(city + '+' + state)}`, label: 'Google Maps' },
    { url: `https://www.tripadvisor.com/Search?q=halal+restaurants+${enc(city + '+' + state)}`, label: 'TripAdvisor' },
    { url: `https://www.doordash.com/search/store/${enc('halal ' + city)}`, label: 'DoorDash' },
    { url: `https://www.ubereats.com/search?q=${enc('halal ' + city)}`, label: 'UberEats' },
    { url: `https://www.grubhub.com/search?orderMethod=delivery&locationMode=DELIVERY&facetSet=uma498b488&pageSize=20&hideHat498=true&searchQuery=${enc('halal')}`, label: 'GrubHub' },
    { url: `https://www.google.com/search?q=${enc('halal restaurants ' + city + ' ' + state + ' site:instagram.com OR site:facebook.com')}`, label: 'Social Media' },
    { url: `https://www.google.com/search?q=${enc('halal food ' + city + ' ' + state + ' review')}`, label: 'Google Reviews' },
    { url: `https://www.google.com/search?q=${enc('halal restaurant ' + city + ' ' + state + ' hidden gem OR new OR underrated')}`, label: 'Hidden Gems' },
  ];

  const target = scrapeTargets[passNum % scrapeTargets.length];
  let scrapedText = '';
  let method = `firecrawl-${target.label.toLowerCase().replace(/\s+/g, '-')}`;

  // Scrape with Firecrawl
  try {
    const fcResp = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${fcKey}` },
      body: JSON.stringify({
        url: target.url,
        formats: ['markdown'],
        onlyMainContent: true,
        timeout: 30000,
      }),
    });

    if (fcResp.status === 429) {
      return res.status(429).json({ error: { message: `Firecrawl rate limit on ${target.label}`, type: 'rate_limit' } });
    }

    if (fcResp.ok) {
      const fcData = await fcResp.json();
      scrapedText = fcData?.data?.markdown || '';
    }
  } catch (e) {
    // Firecrawl failed, will try Google as backup
  }

  // If primary source failed, try Google search as backup
  if (scrapedText.length < 100) {
    try {
      const backupUrl = `https://www.google.com/search?q=${enc('halal restaurants ' + city + ' ' + state)}`;
      const fcResp = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${fcKey}` },
        body: JSON.stringify({ url: backupUrl, formats: ['markdown'], onlyMainContent: true, timeout: 30000 }),
      });
      if (fcResp.ok) {
        const fcData = await fcResp.json();
        scrapedText = fcData?.data?.markdown || '';
        method = `firecrawl-google-backup`;
      }
    } catch (e) { /* skip */ }
  }

  // If still no content, last resort Perplexity search
  if (scrapedText.length < 100) {
    try {
      const resp = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${pplxKey}` },
        body: JSON.stringify({
          model: 'sonar-pro', temperature: 0, return_citations: true,
          messages: [
            { role: 'system', content: 'ONLY return restaurants from actual search results. Every restaurant MUST have a full street address and phone number. SKIP any restaurant that is permanently closed. If temporarily closed, add "Temporarily closed" in notes. Return ONLY a JSON array. No markdown.' },
            { role: 'user', content: `Search for halal restaurants in ${cityState} that are currently open. For EACH one, find the full street address and phone number. Skip any that are permanently closed. Return JSON: [{"name":"","address":"full street address","cuisine":"","phone":"","website":"","notes":"","source":""}]` }
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

  // Extract restaurant names from scraped content, then search for full details
  const JSON_FMT = 'Return ONLY a valid JSON array. Each object: {"name":"","address":"full street address","cuisine":"","phone":"","website":"","notes":"","source":""}. No markdown.';
  try {
    const resp = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${pplxKey}` },
      body: JSON.stringify({
        model: 'sonar-pro', temperature: 0, max_tokens: 4096, return_citations: true,
        messages: [
          {
            role: 'system',
            content: `You are a halal restaurant data enricher. You will receive scraped web content containing restaurant names. Your job:
1. Identify all halal restaurant names from the scraped content
2. For EACH restaurant found, SEARCH the web for its full address, phone number, and website
3. CHECK if each restaurant is still open — if Google/Yelp shows "Permanently closed" or "Closed", SKIP it entirely
4. Every restaurant MUST have a complete street address (number, street, city, state, zip)
5. If a restaurant is "Temporarily closed", include it but add "Temporarily closed" in the notes field
6. If you cannot find the address for a restaurant, still include it but note "address not found"
7. NEVER make up addresses or phone numbers — only include what you find from real listings
8. Do NOT include restaurants that have permanently closed, shut down, or no longer exist
9. ${JSON_FMT}`
          },
          {
            role: 'user',
            content: `Here are halal restaurant listings scraped from ${target.label} for ${cityState}:

${scrapedText.substring(0, 4000)}

For each halal restaurant mentioned above:
1. Extract the restaurant name
2. Search for its full address and phone number in ${cityState}
3. Return complete data with real addresses

${JSON_FMT}`
          }
        ],
      }),
    });
    const data = await resp.json();
    return res.status(200).json({
      content: [{ type: 'text', text: data?.choices?.[0]?.message?.content || '[]' }],
      method, pass: passNum,
    });
  } catch (e) {
    return res.status(500).json({ error: { message: e.message } });
  }
}
