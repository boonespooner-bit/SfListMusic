#!/usr/bin/env python3
"""Enriches show data with Spotify/YouTube links and writes public/data.json.

Strategy:
- Each new band gets a Spotify lookup (until rate-limited) and a YouTube fallback URL.
- Cached misses (spotifyUrl=null) are retried up to RETRY_BUDGET per run, so the
  list of bands-with-Spotify gradually fills in across daily runs even when one
  run gets rate-limited.
"""

import json
import os
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

import spotipy
from spotipy.oauth2 import SpotifyClientCredentials

DATA_PATH = Path(__file__).parent.parent / "public" / "data.json"
CACHE_PATH = Path(__file__).parent.parent / "public" / "music_cache.json"

# How many previously-failed bands to retry per run. Chosen well under
# Spotify's per-minute search rate limit so we rarely get 429'd by retries.
RETRY_BUDGET = 100


def load_cache() -> dict:
    if CACHE_PATH.exists():
        return json.loads(CACHE_PATH.read_text())
    return {}


def save_cache(cache: dict):
    CACHE_PATH.write_text(json.dumps(cache, indent=2, ensure_ascii=False))


def build_spotify_client() -> spotipy.Spotify | None:
    client_id = os.environ.get("SPOTIFY_CLIENT_ID")
    client_secret = os.environ.get("SPOTIFY_CLIENT_SECRET")
    if not client_id or not client_secret:
        print("  SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set — skipping Spotify")
        return None
    try:
        auth = SpotifyClientCredentials(client_id=client_id, client_secret=client_secret)
        # retries=0 so we fail fast on rate-limits instead of blocking for minutes
        return spotipy.Spotify(auth_manager=auth, retries=0, requests_timeout=8)
    except Exception as e:
        print(f"  Spotify init failed: {e}")
        return None


class SpotifyRateLimited(Exception):
    """Raised when Spotify returns 429, signaling we should stop trying."""


def spotify_lookup(sp: spotipy.Spotify, band: str) -> str | None:
    """Return the Spotify artist page URL. Raises SpotifyRateLimited on 429."""
    try:
        results = sp.search(q=f"artist:{band}", type="artist", limit=1)
        items = results.get("artists", {}).get("items", [])
        if items:
            return items[0]["external_urls"]["spotify"]
    except spotipy.exceptions.SpotifyException as e:
        if e.http_status == 429:
            raise SpotifyRateLimited() from e
        print(f"    Spotify error for '{band}': {e}", flush=True)
    except Exception as e:
        msg = str(e)
        if "429" in msg or "Max Retries" in msg:
            raise SpotifyRateLimited() from e
        print(f"    Spotify error for '{band}': {e}", flush=True)
    return None


def youtube_url(band: str) -> str:
    query = "+".join(band.split())
    return f"https://www.youtube.com/results?search_query={query}"


def collect_unique_bands(shows: list[dict]) -> list[str]:
    """Returns the list of unique band names, preserving first-seen order."""
    seen: set[str] = set()
    out: list[str] = []
    for show in shows:
        for band in show.get("bands", []):
            key = band.lower().strip()
            if key in seen:
                continue
            seen.add(key)
            out.append(band)
    return out


def safe_spotify_lookup(sp, band: str, state: dict) -> str | None:
    """Wraps spotify_lookup with state tracking for rate-limit short-circuit."""
    if state["disabled"] or not sp:
        return None
    try:
        return spotify_lookup(sp, band)
    except SpotifyRateLimited:
        print("  Spotify rate-limited; disabling Spotify for rest of run", flush=True)
        state["disabled"] = True
        return None


def enrich_new_bands(bands: list[str], sp, cache: dict, state: dict) -> tuple[int, int]:
    """Look up bands not yet in cache. Returns (new_count, spotify_hits)."""
    new_count = 0
    hits = 0
    for i, band in enumerate(bands, 1):
        key = band.lower().strip()
        if key in cache:
            continue
        new_count += 1
        spotify_url = safe_spotify_lookup(sp, band, state)
        cache[key] = {
            "name": band,
            "spotifyUrl": spotify_url,
            "youtubeUrl": youtube_url(band),
            "lastChecked": datetime.now(timezone.utc).date().isoformat(),
        }
        if spotify_url:
            hits += 1
            print(f"    [new] {band}: spotify=yes", flush=True)
        if new_count % 50 == 0:
            print(f"  New bands: {new_count} processed ({hits} spotify hits)", flush=True)
            save_cache(cache)
    return new_count, hits


def retry_missed_bands(sp, cache: dict, state: dict, budget: int) -> tuple[int, int]:
    """Re-lookup a random sample of previously-cached misses (spotifyUrl=null).
    Returns (attempted, newly_hit)."""
    if state["disabled"] or not sp or budget <= 0:
        return 0, 0
    misses = [k for k, v in cache.items() if v.get("spotifyUrl") is None]
    if not misses:
        return 0, 0
    sample = random.sample(misses, min(budget, len(misses)))
    print(f"  Retrying {len(sample)} of {len(misses)} previously-missed bands (budget={budget})", flush=True)
    attempted = 0
    hits = 0
    today = datetime.now(timezone.utc).date().isoformat()
    for key in sample:
        if state["disabled"]:
            break
        attempted += 1
        display_name = cache[key].get("name") or key
        spotify_url = safe_spotify_lookup(sp, display_name, state)
        cache[key]["lastChecked"] = today
        if spotify_url:
            cache[key]["spotifyUrl"] = spotify_url
            hits += 1
            print(f"    [retry] {key}: spotify=yes", flush=True)
        if attempted % 25 == 0:
            print(f"  Retry progress: {attempted}/{len(sample)} ({hits} new hits)", flush=True)
            save_cache(cache)
    return attempted, hits


def apply_cache_to_shows(shows: list[dict], cache: dict):
    """Convert each show's bands list from [str, ...] to
    [{"name", "spotifyUrl", "youtubeUrl"}, ...]."""
    for show in shows:
        new_bands = []
        for band in show.get("bands", []):
            name = band if isinstance(band, str) else band.get("name", "")
            entry = cache.get(name.lower().strip(), {})
            new_bands.append({
                "name": name,
                "spotifyUrl": entry.get("spotifyUrl"),
                "youtubeUrl": entry.get("youtubeUrl"),
            })
        show["bands"] = new_bands
        # Drop legacy show-level URL fields
        show.pop("spotifyUrl", None)
        show.pop("youtubeUrl", None)


def main():
    if not DATA_PATH.exists():
        print("data.json not found — run scrape.py first", file=sys.stderr)
        sys.exit(1)

    payload = json.loads(DATA_PATH.read_text())
    shows = payload["shows"]

    cache = load_cache()
    sp = build_spotify_client()
    state = {"disabled": False}

    print(f"Loaded cache with {len(cache)} entries", flush=True)
    spotify_known = sum(1 for v in cache.values() if v.get("spotifyUrl"))
    print(f"  Of those, {spotify_known} have Spotify URLs ({len(cache) - spotify_known} are misses)", flush=True)

    unique_bands = collect_unique_bands(shows)
    print(f"Show data has {len(shows)} shows referencing {len(unique_bands)} unique bands", flush=True)

    # Phase 1: look up bands we've never seen before
    new_count, new_hits = enrich_new_bands(unique_bands, sp, cache, state)
    print(f"Phase 1 done: {new_count} new bands processed, {new_hits} Spotify hits", flush=True)

    # Phase 2: retry up to RETRY_BUDGET old misses (only if Spotify still alive)
    attempted, retry_hits = retry_missed_bands(sp, cache, state, RETRY_BUDGET)
    print(f"Phase 2 done: {attempted} retries, {retry_hits} new Spotify hits", flush=True)

    # Single shot: write final cache and apply to all shows
    save_cache(cache)
    apply_cache_to_shows(shows, cache)

    total_bands = sum(len(s["bands"]) for s in shows)
    total_spotify = sum(1 for s in shows for b in s["bands"] if b.get("spotifyUrl"))
    print(f"Final: {total_spotify}/{total_bands} band entries have a Spotify URL", flush=True)

    DATA_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    print(f"Updated {DATA_PATH}", flush=True)


if __name__ == "__main__":
    main()
