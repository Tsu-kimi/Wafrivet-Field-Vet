'use client';

/**
 * app/hooks/useGeolocation.ts
 *
 * Requests browser Geolocation once per component lifetime, reverse-geocodes
 * the result via Nominatim, and returns the detected Nigerian state name.
 *
 * Design constraints:
 *   - Exactly one Geolocation call and one Nominatim request per session.
 *     Do not retry on network failure — just set hasGPSError: true.
 *   - All three GeolocationPositionError codes are handled with user-readable
 *     messages (PERMISSION_DENIED=1, POSITION_UNAVAILABLE=2, TIMEOUT=3).
 *   - Nominatim network failure is silently absorbed: hasGPSError is set,
 *     no exception propagates.
 *
 * Expose: detectedState, hasGPSError, errorMessage, isLoading.
 */

import { useState, useEffect } from 'react';
import { reverseGeocode } from '@/app/lib/nominatim';

export interface UseGeolocationReturn {
  /** Raw Nominatim state string e.g. "Rivers State". Null until resolved. */
  detectedState: string | null;
  /** True if any step (GPS or geocoding) failed. */
  hasGPSError: boolean;
  /** Human-readable error description, or null when no error has occurred. */
  errorMessage: string | null;
  /** True while waiting for GPS hardware or the Nominatim response. */
  isLoading: boolean;
}

const GEO_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 8_000,
  /** Cache position for 60 s to avoid redundant hardware hits on re-mount. */
  maximumAge: 60_000,
};

const GPS_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  1: 'Location permission denied. Please say your state name.',
  2: 'GPS signal unavailable. Please say your state name.',
  3: 'GPS timed out. Please say your state name.',
};

export function useGeolocation(): UseGeolocationReturn {
  const [detectedState, setDetectedState] = useState<string | null>(null);
  const [hasGPSError,   setHasGPSError]   = useState(false);
  const [errorMessage,  setErrorMessage]  = useState<string | null>(null);
  const [isLoading,     setIsLoading]     = useState(false);

  useEffect(() => {
    if (!navigator.geolocation) {
      setHasGPSError(true);
      setErrorMessage(
        'Geolocation is not supported by this browser. Please say your state name.',
      );
      return;
    }

    setIsLoading(true);

    navigator.geolocation.getCurrentPosition(
      async (position: GeolocationPosition) => {
        const { latitude, longitude } = position.coords;

        // Exactly one Nominatim request — no retry on network failure.
        const state = await reverseGeocode(latitude, longitude);

        setIsLoading(false);

        if (state) {
          setDetectedState(state);
        } else {
          setHasGPSError(true);
          setErrorMessage(
            'Could not determine your Nigerian state from GPS. ' +
            'Please say your state name.',
          );
        }
      },
      (err: GeolocationPositionError) => {
        setIsLoading(false);
        setHasGPSError(true);
        setErrorMessage(
          GPS_ERROR_MESSAGES[err.code] ?? 'Location error. Please say your state name.',
        );
      },
      GEO_OPTIONS,
    );
    // Empty dependency array: one geolocation + one Nominatim call per mount.
  }, []);

  return { detectedState, hasGPSError, errorMessage, isLoading };
}
