/**
 * app/api/geocode/route.ts
 *
 * Server-side Next.js API route — reverse geocodes a lat/lon pair.
 *
 * Strategy:
 *   1. Google Geocoding API  — primary (requires GOOGLE_MAPS_KEY env var)
 *   2. OpenStreetMap Nominatim — automatic fallback when key is absent
 *
 * Request:  GET /api/geocode?lat=<number>&lon=<number>
 * Response: { state, lga, formattedAddress }  on success
 *           { error: string }                 on failure
 *
 * Status codes mirrored from Google when Google is used:
 *   200 — geocode succeeded
 *   404 — ZERO_RESULTS (remote or ocean coordinates)
 *   400 — missing or invalid parameters
 *   429 — OVER_QUERY_LIMIT
 *   403 — REQUEST_DENIED (key has website/referer restrictions — must use None + API restrictions only)
 *   500 — unexpected API error or fetch failure
 *   503 — all providers failed (Google key absent and Nominatim also failed)
 *
 * Extracts:
 *   administrative_area_level_1 → state  (Nigerian state, e.g. "Rivers State")
 *   administrative_area_level_2 → lga    (LGA, e.g. "Port Harcourt")
 *   formatted_address           → formattedAddress
 *
 * Security: The key is read from process.env.GOOGLE_MAPS_KEY (never NEXT_PUBLIC_).
 * The raw Google API response is NEVER forwarded to the browser.
 */

import { NextRequest, NextResponse } from 'next/server';

const GEOCODING_BASE = 'https://maps.googleapis.com/maps/api/geocode/json';
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/reverse';
const NOMINATIM_UA   = 'WafriAI/1.0 (+https://github.com/Tsu-kimi/Wafrivet-Field-Vet)';

// ── Google Geocoding types ────────────────────────────────────────────────────

interface AddressComponent {
  long_name: string;
  short_name: string;
  types: string[];
}

interface GeocodingResult {
  address_components: AddressComponent[];
  formatted_address: string;
  types: string[];
}

interface GeocodingResponse {
  status: string;
  results: GeocodingResult[];
  error_message?: string;
}

// ── Nominatim fallback ────────────────────────────────────────────────────────

interface NominatimResponse {
  display_name?: string;
  address?: {
    state?: string;
    state_district?: string;
    county?: string;
    city?: string;
    town?: string;
    country_code?: string;
  };
  error?: string;
}

async function geocodeViaNominatim(
  lat: number,
  lon: number,
): Promise<{ state: string; lga: string | null; formattedAddress: string } | null> {
  const url = new URL(NOMINATIM_BASE);
  url.searchParams.set('format', 'json');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  url.searchParams.set('zoom', '10');
  url.searchParams.set('addressdetails', '1');

  console.log(`[/api/geocode] Nominatim fallback for lat=${lat}, lon=${lon}`);

  try {
    const resp = await fetch(url.toString(), {
      headers: { 'User-Agent': NOMINATIM_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) {
      console.warn(`[/api/geocode] Nominatim HTTP ${resp.status}`);
      return null;
    }
    const data = await resp.json() as NominatimResponse;
    if (data.error || !data.address) {
      console.warn('[/api/geocode] Nominatim error or no address:', data.error);
      return null;
    }
    const state = data.address.state ?? null;
    if (!state) {
      console.warn('[/api/geocode] Nominatim response has no state field');
      return null;
    }
    const lga = data.address.state_district
      ?? data.address.county
      ?? data.address.city
      ?? data.address.town
      ?? null;
    const formattedAddress = data.display_name ?? state;
    console.log(`[/api/geocode] Nominatim resolved → state="${state}", lga="${lga}"`);
    return { state, lga, formattedAddress };
  } catch (err) {
    console.error('[/api/geocode] Nominatim fetch error:', err);
    return null;
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const latStr = params.get('lat');
  const lonStr = params.get('lon');

  // ── Parameter validation ──────────────────────────────────────────────────
  if (!latStr || !lonStr) {
    return NextResponse.json(
      { error: 'Missing required query parameters: lat, lon' },
      { status: 400 },
    );
  }

  const lat = parseFloat(latStr);
  const lon = parseFloat(lonStr);

  if (!isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return NextResponse.json(
      { error: 'Invalid lat/lon values' },
      { status: 400 },
    );
  }

  // ── API key — server-side only ────────────────────────────────────────────
  const apiKey = process.env.GOOGLE_MAPS_KEY;
  if (!apiKey) {
    // Key not configured in Vercel env vars — fall back to Nominatim immediately.
    console.warn('[/api/geocode] GOOGLE_MAPS_KEY not set — using Nominatim fallback');
    const result = await geocodeViaNominatim(lat, lon);
    if (result) return NextResponse.json(result);
    return NextResponse.json({ error: 'Geocoding service unavailable' }, { status: 503 });
  }

  // ── Call Google Geocoding API (server-side) ───────────────────────────────
  const url = new URL(GEOCODING_BASE);
  url.searchParams.set('latlng', `${lat},${lon}`);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('language', 'en');
  // result_type filter improves relevance for administrative lookups.
  // Omit it here — we scan all results for administrative_area_level_1.

  console.log(`[/api/geocode] Reverse geocoding lat=${lat}, lon=${lon}`);

  let geoData: GeocodingResponse;
  try {
    const resp = await fetch(url.toString(), {
      // No Referer header — the key uses API-only restrictions (no website
      // restriction), so server-side calls are accepted without a referrer.
      // Do NOT add a Referer header: keys with website restrictions explicitly
      // reject server-side Geocoding API calls regardless of what is sent.
      // Cache for 5 minutes — GPS accuracy rarely changes within a session.
      next: { revalidate: 300 },
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    geoData = await resp.json() as GeocodingResponse;
  } catch (err) {
    console.error('[/api/geocode] Fetch error:', err);
    return NextResponse.json(
      { error: 'Failed to reach geocoding service' },
      { status: 500 },
    );
  }

  // ── Handle Google API status codes ────────────────────────────────────────
  switch (geoData.status) {
    case 'OK':
      break;
    case 'ZERO_RESULTS':
      return NextResponse.json(
        { error: 'No address found for these coordinates' },
        { status: 404 },
      );
    case 'OVER_QUERY_LIMIT':
      console.warn('[/api/geocode] Geocoding quota exceeded');
      return NextResponse.json(
        { error: 'Geocoding quota exceeded — try again shortly' },
        { status: 429 },
      );
    case 'REQUEST_DENIED':
      console.error(
        '[/api/geocode] REQUEST_DENIED:', geoData.error_message,
        '— key restriction or billing issue. Falling back to Nominatim.',
      );
      {
        const fallback = await geocodeViaNominatim(lat, lon);
        if (fallback) return NextResponse.json(fallback);
      }
      return NextResponse.json(
        { error: 'Geocoding request denied' },
        { status: 403 },
      );
    default:
      console.error('[/api/geocode] Unexpected status:', geoData.status, geoData.error_message);
      return NextResponse.json(
        { error: 'Geocoding failed' },
        { status: 500 },
      );
  }

  // ── Extract administrative components from the first usable result ────────
  // The Geocoding API returns multiple results at different granularity levels.
  // We scan all results' address_components to find the two targets, because
  // administrative_area_level_1 and _level_2 may appear in different results.
  let state: string | null = null;
  let lga: string | null = null;
  let formattedAddress = '';

  for (const result of geoData.results) {
    if (!formattedAddress) formattedAddress = result.formatted_address;
    for (const component of result.address_components) {
      if (!state && component.types.includes('administrative_area_level_1')) {
        state = component.long_name;
      }
      if (!lga && component.types.includes('administrative_area_level_2')) {
        lga = component.long_name;
      }
    }
    if (state && lga) break;
  }

  if (!state) {
    console.warn(`[/api/geocode] No administrative_area_level_1 found for lat=${lat}, lon=${lon}. Google status=${geoData.status}, results=${geoData.results.length}`);
    return NextResponse.json(
      { error: 'Could not determine state from these coordinates' },
      { status: 404 },
    );
  }

  console.log(`[/api/geocode] Resolved lat=${lat}, lon=${lon} → state="${state}", lga="${lga}", address="${formattedAddress}"`);
  return NextResponse.json({ state, lga: lga ?? null, formattedAddress });
}
