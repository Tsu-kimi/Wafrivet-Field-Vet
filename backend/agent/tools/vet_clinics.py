"""
backend/agent/tools/vet_clinics.py

ADK tool: find_nearest_vet_clinic

Searches for the nearest veterinary clinics using the Google Places API (New)
Nearby Search endpoint.  Called by Fatima when a diagnosed condition has
severity "critical" or when the farmer explicitly asks for a nearby vet.

Works by reading the farmer's GPS coordinates (farmer_lat, farmer_lon) that
the frontend wrote into session state via the LOCATION_DATA WebSocket message
at the start of the session.

Radius fallback strategy:
    1. 10 000 m  (10 km)  — most rural areas have something within 10 km
    2. 25 000 m  (25 km)  — extended search for more remote locations
    3. 50 000 m  (50 km)  — maximum radius (API hard limit)

Returns up to 5 results ordered by proximity (DISTANCE rankPreference).

If no GPS coordinates are stored in session state, returns a structured
empty result with a fallback message that Fatima can speak aloud.

FieldMask is strictly limited to the fields we display:
    places.displayName
    places.formattedAddress
    places.nationalPhoneNumber
    places.currentOpeningHours
    places.googleMapsUri
    places.location

Using only these fields keeps billing at the Nearby Search Pro SKU tier for
the first three fields and rolls up to Enterprise for nationalPhoneNumber and
currentOpeningHours — photos and reviews are explicitly excluded.

Environment variables required:
    GOOGLE_MAPS_KEY — Google Maps Platform API key with Places API (New) enabled.
                      Must NOT be set as NEXT_PUBLIC_ anywhere; injected at
                      Cloud Run deploy time via Secret Manager GOOGLE_MAPS_KEY:latest.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Optional

import httpx
from google.adk.tools.tool_context import ToolContext

logger = logging.getLogger("wafrivet.tools.vet_clinics")

# Google Places API (New) Nearby Search endpoint.
# Never use the legacy maps.googleapis.com endpoint.
_PLACES_URL = "https://places.googleapis.com/v1/places:searchNearby"
_GEOCODING_URL = "https://maps.googleapis.com/maps/api/geocode/json"

# FieldMask controls billing tier — only request what we display.
# nationalPhoneNumber + currentOpeningHours → Enterprise SKU.
# No photos, reviews, or atmosphere fields.
_FIELD_MASK = (
    "places.displayName,"
    "places.formattedAddress,"
    "places.nationalPhoneNumber,"
    "places.currentOpeningHours,"
    "places.googleMapsUri,"
    "places.location"
)

# veterinary_care is confirmed in Table A of the Places API (New) place types.
# pet_care is also in Table A (Services category) as a secondary catch-all.
_INCLUDED_TYPES = ["veterinary_care", "pet_care"]

# Radius fallback ladder (metres).  Max is 50 000 m per the API spec.
_RADIUS_FALLBACK = [10_000.0, 25_000.0, 50_000.0]

# Max results per API call (must be between 1 and 20).
_MAX_RESULTS = 5

# NAFDAC animal health helpline (Nigeria) — spoken when no clinics found.
_NAFDAC_HELPLINE = "0800-162-3232"

# Cache resolved coordinates for 2 hours to avoid repeated geocoding of the
# same farmer location string.
_GEOCODE_CACHE_TTL_SECONDS = 2 * 60 * 60


def _api_key() -> str:
    key = os.environ.get("GOOGLE_MAPS_KEY", "").strip()
    if not key:
        raise EnvironmentError(
            "GOOGLE_MAPS_KEY environment variable is not set. "
            "Add it to Cloud Run via --set-secrets=GOOGLE_MAPS_KEY=GOOGLE_MAPS_KEY:latest."
        )
    return key


def _geocode_cache_key(location_query: str) -> str:
    normalized = " ".join(location_query.strip().lower().split())
    return f"geocode_coords:{normalized}"


async def _geocode_location(location_query: str) -> tuple[Optional[float], Optional[float]]:
    """
    Forward-geocode a Nigerian location string to coordinates.

    Uses Redis for a 2-hour cache so repeated clinic lookups for the same
    location do not keep hitting the Geocoding API.
    """
    if not location_query.strip():
        return None, None

    cache_key = _geocode_cache_key(location_query)
    try:
        from backend.services.redis_client import get_redis

        redis = get_redis()
        cached = await redis.get(cache_key)
        if cached:
            parsed = json.loads(cached)
            return float(parsed["lat"]), float(parsed["lon"])
    except Exception as exc:
        logger.warning("geocode cache read failed: %s", exc)

    params = {
        "address": location_query,
        "components": "country:NG",
        "language": "en",
        "key": _api_key(),
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(_GEOCODING_URL, params=params)
        resp.raise_for_status()
        payload = resp.json()
    except httpx.HTTPStatusError as exc:
        logger.warning(
            "Geocoding API error: %s %s",
            exc.response.status_code,
            exc.response.text[:200],
        )
        return None, None
    except Exception as exc:
        logger.warning("Geocoding API unexpected error: %s", exc)
        return None, None

    if payload.get("status") != "OK" or not payload.get("results"):
        logger.warning(
            "Geocoding API returned status=%s for query=%r",
            payload.get("status"),
            location_query,
        )
        return None, None

    location = (((payload.get("results") or [])[0] or {}).get("geometry") or {}).get("location") or {}
    lat = location.get("lat")
    lon = location.get("lng")
    if lat is None or lon is None:
        return None, None

    try:
        from backend.services.redis_client import get_redis

        redis = get_redis()
        await redis.setex(
            cache_key,
            _GEOCODE_CACHE_TTL_SECONDS,
            json.dumps({"lat": float(lat), "lon": float(lon)}),
        )
    except Exception as exc:
        logger.warning("geocode cache write failed: %s", exc)

    return float(lat), float(lon)


async def _search_nearby(lat: float, lon: float, radius_m: float) -> list[dict[str, Any]]:
    """
    Call the Places API (New) Nearby Search for veterinary clinics.

    Returns the raw list of place dicts from the response, or [] on error.
    Never raises — errors are logged and surfaced as empty results.
    Uses AsyncClient to avoid blocking the asyncio event loop.
    """
    body = {
        "includedTypes": _INCLUDED_TYPES,
        "maxResultCount": _MAX_RESULTS,
        "rankPreference": "DISTANCE",
        "locationRestriction": {
            "circle": {
                "center": {"latitude": lat, "longitude": lon},
                "radius": radius_m,
            }
        },
    }
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": _api_key(),
        "X-Goog-FieldMask": _FIELD_MASK,
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(_PLACES_URL, json=body, headers=headers)
        payload = resp.json()
        resp.raise_for_status()
        places = payload.get("places") or []
        if not places:
            logger.info(
                "Places API returned zero results for lat=%.5f lon=%.5f radius_m=%.0f payload_snippet=%s",
                lat,
                lon,
                radius_m,
                json.dumps(payload)[:400],
            )
        return places
    except httpx.HTTPStatusError as exc:
        logger.warning(
            "Places API error: %s %s",
            exc.response.status_code,
            exc.response.text[:200],
        )
        return []
    except Exception as exc:
        logger.warning("Places API unexpected error: %s", exc)
        return []


def _normalise_clinic(place: dict[str, Any]) -> dict[str, Any]:
    """
    Map a raw Places API (New) place dict to the CLINICS_FOUND event shape.

    Frontend contract (must match ClinicCardRow.tsx expectations):
        name          — str
        address       — str
        phone         — str | None
        openNow       — bool | None
        googleMapsUri — str | None
        lat           — float | None
        lon           — float | None
    """
    display_name = place.get("displayName") or {}
    name: str = display_name.get("text", "Veterinary Clinic")

    address: str = place.get("formattedAddress", "")
    phone: Optional[str] = place.get("nationalPhoneNumber") or None
    google_maps_uri: Optional[str] = place.get("googleMapsUri") or None

    opening_hours = place.get("currentOpeningHours") or {}
    open_now: Optional[bool] = opening_hours.get("openNow")

    location = place.get("location") or {}
    lat: Optional[float] = location.get("latitude")
    lon: Optional[float] = location.get("longitude")

    return {
        "name": name,
        "address": address,
        "phone": phone,
        "openNow": open_now,
        "googleMapsUri": google_maps_uri,
        "lat": lat,
        "lon": lon,
    }


async def find_nearest_vet_clinic(tool_context: ToolContext) -> dict[str, Any]:
    """
    ADK tool — find the nearest veterinary clinics for the farmer's location.

    Coordinate resolution priority:
      1. farmer_lat / farmer_lon already in session state (from device GPS via
         the LOCATION_DATA WebSocket message) — most accurate, used directly.
      2. Geocode from farmer_lga + farmer_state text if GPS not present.

    Then runs a Places API (New) Nearby Search with a radius fallback ladder.

    Returns:
        {
            "status": "success" | "error",
            "data": {
                "clinics": [...],           # up to 5 clinic objects
                "radius_m": float,          # effective search radius used
                "fallback_message": str | None
            },
            "message": str
        }
    """
    session = tool_context.state

    # ── Step 1: resolve coordinates ──────────────────────────────────────────
    # Prefer the precise device GPS that the frontend sent via LOCATION_DATA.
    raw_lat = session.get("farmer_lat")
    raw_lon = session.get("farmer_lon")

    lat_f: Optional[float] = None
    lon_f: Optional[float] = None

    if raw_lat is not None and raw_lon is not None:
        try:
            lat_f = float(raw_lat)
            lon_f = float(raw_lon)
            logger.info(
                "find_nearest_vet_clinic: using device GPS lat=%.5f lon=%.5f",
                lat_f, lon_f,
            )
        except (TypeError, ValueError):
            lat_f = None
            lon_f = None

    if lat_f is None or lon_f is None:
        # No device GPS — fall back to geocoding the text location.
        farmer_state = str(session.get("farmer_state") or "").strip()
        farmer_lga   = str(session.get("farmer_lga") or "").strip()

        if not farmer_state:
            fallback_msg = (
                "I need your Nigerian state before I can find the nearest "
                "veterinary clinic. Please tell me your state."
            )
            return {
                "status": "success",
                "data": {"clinics": [], "radius_m": 0, "fallback_message": fallback_msg},
                "message": fallback_msg,
            }

        location_query = (
            f"{farmer_lga}, {farmer_state}, Nigeria"
            if farmer_lga
            else f"{farmer_state}, Nigeria"
        )
        logger.info(
            "find_nearest_vet_clinic: no device GPS — geocoding %r", location_query
        )
        lat_f, lon_f = await _geocode_location(location_query)

    if lat_f is None or lon_f is None:
        farmer_state = str(session.get("farmer_state") or "unknown location").strip()
        return {
            "status": "success",
            "data": {
                "clinics": [],
                "radius_m": 0,
                "fallback_message": (
                    f"I could not determine your exact location from {farmer_state}. "
                    "Please confirm your state or local government area and try again."
                ),
            },
            "message": "Could not resolve location to coordinates.",
        }

    # ── Step 2: search with radius fallback ladder ───────────────────────────
    clinics: list[dict[str, Any]] = []
    effective_radius = 0.0

    for radius_m in _RADIUS_FALLBACK:
        raw_places = await _search_nearby(lat_f, lon_f, radius_m)
        if raw_places:
            clinics = [_normalise_clinic(p) for p in raw_places]
            effective_radius = radius_m
            break
        logger.info(
            "No vet clinics within %.0f m of (%.5f, %.5f) — expanding radius",
            radius_m, lat_f, lon_f,
        )

    if not clinics:
        fallback_msg = (
            f"I searched up to 50 km around you but couldn't find a registered "
            f"veterinary clinic nearby. Please call the NAFDAC animal health helpline "
            f"at {_NAFDAC_HELPLINE} for emergency veterinary referrals."
        )
        return {
            "status": "success",
            "data": {
                "clinics": [],
                "radius_m": 50_000.0,
                "fallback_message": fallback_msg,
            },
            "message": fallback_msg,
        }

    nearest = clinics[0]
    name = nearest["name"]
    address = nearest.get("address") or "no address on record"
    phone_note = f", phone: {nearest['phone']}" if nearest.get("phone") else ""

    summary = (
        f"Nearest veterinary clinic: {name}, at {address}{phone_note}. "
        f"Found {len(clinics)} clinic(s) within {int(effective_radius / 1000)} km."
    )

    logger.info(
        "find_nearest_vet_clinic: %d clinic(s) found within %.0f m of (%.5f, %.5f)",
        len(clinics), effective_radius, lat_f, lon_f,
    )

    return {
        "status": "success",
        "data": {
            "clinics": clinics,
            "radius_m": effective_radius,
            "fallback_message": None,
        },
        "message": summary,
    }
