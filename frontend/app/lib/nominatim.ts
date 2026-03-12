/**
 * app/lib/nominatim.ts
 *
 * Reverse geocoding via OpenStreetMap Nominatim API.
 * No API key required — Nominatim is free for reasonable request rates.
 * Nominatim usage policy requires a descriptive User-Agent header.
 *
 * Called from useGeolocation (client-side only).
 * Returns the raw Nominatim state string (e.g. "Rivers State").
 * The backend ADK update_location tool normalises it to canonical form.
 *
 * Reference: https://nominatim.org/release-docs/latest/api/Reverse/
 */

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/reverse';

// Nominatim requires a User-Agent identifying the application.
// Use a descriptive string per the usage policy.
const USER_AGENT = 'WafriAI/1.0 (+https://github.com/Tsu-kimi/Wafrivet-Field-Vet)';

interface NominatimAddress {
  state?: string;
  state_district?: string;
  county?: string;
  country?: string;
  country_code?: string;
}

interface NominatimReverseResult {
  place_id?: number;
  osm_type?: string;
  display_name?: string;
  address?: NominatimAddress;
  error?: string;
}

/**
 * Reverse-geocode GPS coordinates to a Nigerian state name.
 *
 * @param lat - WGS84 latitude
 * @param lon - WGS84 longitude
 * @returns Raw state string from Nominatim (e.g. "Rivers State") or null.
 *          Returns null if the coordinates are outside Nigeria, the request
 *          fails, or the response is malformed.
 */
export async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  const url = new URL(NOMINATIM_BASE);
  url.searchParams.set('format', 'json');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  // Zoom level 5 = state/region detail — avoids unnecessary address details
  url.searchParams.set('zoom', '5');
  url.searchParams.set('addressdetails', '1');

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      // 5-second hard timeout; AbortSignal.timeout available in modern browsers
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Network error or timeout
    return null;
  }

  if (!response.ok) return null;

  let data: NominatimReverseResult;
  try {
    data = (await response.json()) as NominatimReverseResult;
  } catch {
    return null;
  }

  // Reject Nominatim error responses (e.g. coordinates outside coverage)
  if (data.error || !data.address) return null;

  // Only return results within Nigeria (country_code = 'ng')
  if (data.address.country_code?.toLowerCase() !== 'ng') return null;

  return data.address.state ?? null;
}
