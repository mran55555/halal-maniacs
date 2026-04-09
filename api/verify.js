// Vercel Serverless — Google Places verification endpoint

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY not configured' });

  const { name, address, city, state } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  try {
    const query = `${name} ${city || ''} ${state || ''}`.trim();
    const enc = encodeURIComponent;

    // Step 1: Find Place
    const findResp = await fetch(
      `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${enc(query)}&inputtype=textquery&fields=place_id,name,formatted_address,geometry&key=${apiKey}`
    );
    const findData = await findResp.json();
    const candidates = findData.candidates || [];

    if (!candidates.length) {
      return res.status(200).json({
        found: false,
        note: 'Not found on Google Maps'
      });
    }

    const placeId = candidates[0].place_id;

    // Step 2: Get Place Details
    const detailsResp = await fetch(
      `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,formatted_address,formatted_phone_number,website,rating,user_ratings_total,opening_hours,business_status,types&key=${apiKey}`
    );
    const detailsData = await detailsResp.json();
    const place = detailsData.result || {};

    const businessStatus = place.business_status || 'OPERATIONAL';
    const isOpen = place.opening_hours?.open_now;

    return res.status(200).json({
      found: true,
      placeId,
      name: place.name || name,
      address: place.formatted_address || address,
      phone: place.formatted_phone_number || '',
      website: place.website || '',
      rating: place.rating || null,
      totalRatings: place.user_ratings_total || 0,
      isOpenNow: isOpen ?? null,
      businessStatus,
      permanentlyClosed: businessStatus === 'CLOSED_PERMANENTLY',
      temporarilyClosed: businessStatus === 'CLOSED_TEMPORARILY',
      gmaps: `https://www.google.com/maps/place/?q=place_id:${placeId}`,
      types: place.types || [],
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
