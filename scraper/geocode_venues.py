#!/usr/bin/env python3
"""Geocodes venues from data.json using Nominatim (OpenStreetMap). Free, no API key.
Writes public/venue_coords.json — cached so each venue is only looked up once."""

import json
import sys
import time
from pathlib import Path

import requests

DATA_PATH = Path(__file__).parent.parent / "public" / "data.json"
COORDS_PATH = Path(__file__).parent.parent / "public" / "venue_coords.json"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
HEADERS = {"User-Agent": "SfListMusic-Geocoder/1.0 (github.com/boonespooner-bit/sflistmusic)"}

# Bay Area search hints — appended to venue name when geocoding
SEARCH_SUFFIXES = [
    ", San Francisco, CA",
    ", Oakland, CA",
    ", Berkeley, CA",
    ", San Jose, CA",
    ", Bay Area, CA",
]


def load_coords() -> dict:
    if COORDS_PATH.exists():
        return json.loads(COORDS_PATH.read_text())
    return {}


def geocode(venue_name: str) -> tuple[float, float] | None:
    for suffix in SEARCH_SUFFIXES:
        try:
            r = requests.get(
                NOMINATIM,
                params={"q": venue_name + suffix, "format": "json", "limit": 1},
                headers=HEADERS,
                timeout=10,
            )
            r.raise_for_status()
            results = r.json()
            if results:
                return float(results[0]["lat"]), float(results[0]["lon"])
        except Exception as e:
            print(f"    Nominatim error for '{venue_name}': {e}", flush=True)
        time.sleep(1.1)  # Nominatim asks for max 1 req/sec
    return None


def main():
    if not DATA_PATH.exists():
        print("data.json not found", file=sys.stderr)
        sys.exit(1)

    data = json.loads(DATA_PATH.read_text())
    coords = load_coords()

    # Collect unique venues by URL-key (stable across days)
    all_venues: dict[str, str] = {}
    for show in data["shows"]:
        key = show["venue"].get("url") or show["venue"]["name"]
        all_venues[key] = show["venue"]["name"]

    missing = {k: v for k, v in all_venues.items() if k not in coords}
    print(f"Venues total: {len(all_venues)}, already cached: {len(all_venues) - len(missing)}, to geocode: {len(missing)}", flush=True)

    new_found = 0
    for key, name in missing.items():
        result = geocode(name)
        if result:
            coords[key] = {"name": name, "lat": result[0], "lng": result[1]}
            new_found += 1
            print(f"  ✓ {name}: {result[0]:.4f}, {result[1]:.4f}", flush=True)
        else:
            coords[key] = {"name": name, "lat": None, "lng": None}
            print(f"  ✗ {name}: not found", flush=True)
        time.sleep(1.1)

    COORDS_PATH.write_text(json.dumps(coords, indent=2, ensure_ascii=False))
    geocoded = sum(1 for v in coords.values() if v.get("lat"))
    print(f"Done. {geocoded}/{len(coords)} venues have coordinates.", flush=True)


if __name__ == "__main__":
    main()
