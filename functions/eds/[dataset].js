// Cloudflare Pages Function: the Energinet proxy for static hosting (replaces serve.py's /eds/ route).
// Energinet answers browser requests (anything with an Origin header) with an empty body; a server-side fetch is fine.
const ALLOWED = { PowerSystemRightNow: 25, DayAheadPrices: 180, ImbalancePrice: 60 };      // dataset -> cache seconds

export async function onRequestGet({ params, request }) {
  const ttl = ALLOWED[params.dataset];
  if (!ttl) return new Response('dataset not proxied', { status: 404 });
  const upstream = 'https://api.energidataservice.dk/dataset/' + params.dataset + new URL(request.url).search;
  const r = await fetch(upstream, { headers: { 'User-Agent': 'dk-wind/1.0' }, cf: { cacheTtl: ttl, cacheEverything: true } });
  return new Response(r.body, {
    status: r.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${ttl}` },
  });
}
