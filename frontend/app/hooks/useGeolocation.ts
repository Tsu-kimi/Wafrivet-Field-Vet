'use client';

/**
 * app/hooks/useGeolocation.ts
 *
 * Requests browser Geolocation once per component lifetime, then resolves
 * the coordinates into a structured Nigerian address by calling the server-side
 * /api/geocode route (which calls Google Geocoding API with GOOGLE_MAPS_KEY).
 *
 * Design constraints:
 *   - Exactly one Geolocation call and one /api/geocode request per session.
 *     Do not retry on network failure — just set hasGPSError: true.
 *   - All three GeolocationPositionError codes are handled with user-readable
 *     messages (PERMISSION_DENIED=1, POSITION_UNAVAILABLE=2, TIMEOUT=3).
 *   - /api/geocode network failure is silently absorbed: hasGPSError is set,
 *     no exception propagates to the caller.
 *   - Raw GPS coordinates (lat, lon) are exposed so FieldVetSession can send
 *     them to the backend via LOCATION_DATA for find_nearest_vet_clinic.
 *   - GOOGLE_MAPS_KEY is NEVER accessed here — it lives only in the server-side
 *     /api/geocode route.
 *
 * Expose: detectedState, lga, lat, lon, formattedAddress,
 *         hasGPSError, errorMessage, isLoading.
 */

import { useState, useEffect } from 'react';

export interface UseGeolocationReturn {
  /** Resolved Nigerian state name e.g. "Rivers State". Null until resolved. */
  detectedState: string | null;
  /** Nigerian LGA name e.g. "Port Harcourt". Null until resolved. */
  lga: string | null;
  /** Raw GPS latitude from the browser. Null until GPS resolves. */
  lat: number | null;
  /** Raw GPS longitude from the browser. Null until GPS resolves. */
  lon: number | null;
  /** Formatted address from the Geocoding API e.g. "Port Harcourt, Rivers, Nigeria". */
  formattedAddress: string | null;
  /** True if any step (GPS or geocoding) failed. */
  hasGPSError: boolean;
  /** Human-readable error description, or null when no error has occurred. */
  errorMessage: string | null;
  /** True while waiting for GPS hardware or the /api/geocode response. */
  isLoading: boolean;
}

const GEO_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  // Increased to 10 s per Phase 2 spec (was 8 s).
  timeout: 10_000,
  /**
   * Do not use a stale cached position — always request a fresh GPS fix.
   * A 5-minute cache (the previous value) could serve a stale IP-based
   * position from a different session, causing wrong-city results (often Lagos).
   */
  maximumAge: 0,
};

const GPS_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  1: 'Location permission denied. Please say your state name.',
  2: 'GPS signal unavailable. Please say your state name.',
  3: 'GPS timed out. Please say your state name.',
};

export function useGeolocation(): UseGeolocationReturn {
  const [detectedState,    setDetectedState]    = useState<string | null>(null);
  const [lga,              setLga]              = useState<string | null>(null);
  const [lat,              setLat]              = useState<number | null>(null);
  const [lon,              setLon]              = useState<number | null>(null);
  const [formattedAddress, setFormattedAddress] = useState<string | null>(null);
  const [hasGPSError,      setHasGPSError]      = useState(false);
  const [errorMessage,     setErrorMessage]     = useState<string | null>(null);
  const [isLoading,        setIsLoading]        = useState(false);

  useEffect(() => {
    if (!navigator.geolocation) {
      console.warn('[useGeolocation] navigator.geolocation is not available in this browser');
      setHasGPSError(true);
      setErrorMessage(
        'Geolocation is not supported by this browser. Please say your state name.',
      );
      return;
    }

    console.log('[useGeolocation] Requesting browser geolocation (enableHighAccuracy=true, timeout=10s, maximumAge=0)…');
    setIsLoading(true);

    navigator.geolocation.getCurrentPosition(
      async (position: GeolocationPosition) => {
        const { latitude, longitude, accuracy } = position.coords;

        console.log(
          `[useGeolocation] GPS fix received — lat: ${latitude}, lon: ${longitude}, accuracy: ${accuracy}m`,
        );

        // Accuracy > 5 km almost always means the browser fell back to IP-based
        // geolocation (no GPS hardware or no signal). In Nigeria, IP-based
        // geolocation usually resolves to Lagos. We still proceed, but warn.
        if (accuracy > 5_000) {
          console.warn(
            `[useGeolocation] Low accuracy (${accuracy}m) — browser is likely using IP-based location, not GPS. ` +
            'This commonly reports Lagos for Nigerian connections regardless of actual location.',
          );
        }

        // Store raw coordinates immediately — available to FieldVetSession
        // even if the /api/geocode call fails.
        setLat(latitude);
        setLon(longitude);

        // Call the server-side proxy; GOOGLE_MAPS_KEY never touches the browser.
        try {
          console.log(`[useGeolocation] Calling /api/geocode for lat=${latitude}, lon=${longitude}…`);
          const resp = await fetch(
            `/api/geocode?lat=${latitude}&lon=${longitude}`,
          );

          if (resp.ok) {
            const data = await resp.json() as {
              state: string;
              lga: string | null;
              formattedAddress: string;
            };
            console.log(
              `[useGeolocation] Geocode success — state: "${data.state}", lga: "${data.lga}", address: "${data.formattedAddress}"`,
            );
            setDetectedState(data.state);
            setLga(data.lga ?? null);
            setFormattedAddress(data.formattedAddress ?? null);
          } else {
            // /api/geocode returned a structured error — GPS still worked.
            let errBody = '(could not read body)';
            try { errBody = await resp.text(); } catch { /* ignore */ }
            console.warn(
              `[useGeolocation] /api/geocode returned HTTP ${resp.status} — body: ${errBody}`,
            );
            setHasGPSError(true);
            setErrorMessage(
              'Could not determine your Nigerian state from GPS. ' +
              'Please say your state name.',
            );
          }
        } catch (fetchErr) {
          console.error('[useGeolocation] /api/geocode fetch threw an error:', fetchErr);
          setHasGPSError(true);
          setErrorMessage(
            'Could not reach the geocoding service. Please say your state name.',
          );
        }

        setIsLoading(false);
      },
      (err: GeolocationPositionError) => {
        console.warn(
          `[useGeolocation] GPS error — code: ${err.code}, message: "${err.message}"`,
        );
        setIsLoading(false);
        setHasGPSError(true);
        setErrorMessage(
          GPS_ERROR_MESSAGES[err.code] ?? 'Location error. Please say your state name.',
        );
      },
      GEO_OPTIONS,
    );
    // Empty dependency array: one geolocation + one geocode call per mount.
  }, []);

  return {
    detectedState,
    lga,
    lat,
    lon,
    formattedAddress,
    hasGPSError,
    errorMessage,
    isLoading,
  };
}
