#!/usr/bin/env python3
"""Enriches show data with Spotify/YouTube links and writes public/data.json."""

import json
import os
import sys
import time
from pathlib import Path

import spotipy
from spotipy.oauth2 import SpotifyClientCredentials
import requests

DATA_PATH = Path(__file__).parent.parent / "public" / "data.json"
CACHE_PATH = Path(__file__).parent.parent / "public" / "music_cache.json"

YT_SEARCH_URL = "https://www.youtube.com/results?search_query={query}+music"


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


def enrich(shows: list[dict], sp: spotipy.Spotify | None, cache: dict) -> int:
    changed = 0
    seen: set[str] = set()
    total = sum(len(s.get("bands", [])) for s in shows)
    processed = 0
    spotify_disabled = False

    for show in shows:
        for band in show.get("bands", []):
            key = band.lower().strip()
            if key in seen:
                continue
            seen.add(key)
            processed += 1
            if processed % 50 == 0:
                print(f"  Progress: {processed}/{total} ({changed} new lookups, spotify_on={not spotify_disabled})", flush=True)
                save_cache(cache)  # checkpoint so cancelled runs don't lose progress

            if key in cache:
                show["spotifyUrl"] = cache[key].get("spotifyUrl")
                show["youtubeUrl"] = cache[key].get("youtubeUrl")
                continue

            spotify_url = None
            if sp and not spotify_disabled:
                try:
                    spotify_url = spotify_lookup(sp, band)
                except SpotifyRateLimited:
                    print("  Spotify rate-limited; disabling Spotify for rest of run", flush=True)
                    spotify_disabled = True

            yt_url = youtube_url(band)

            cache[key] = {"spotifyUrl": spotify_url, "youtubeUrl": yt_url}
            show["spotifyUrl"] = spotify_url
            show["youtubeUrl"] = yt_url
            changed += 1
            if spotify_url:
                print(f"    {band}: spotify=yes", flush=True)

    return changed


def main():
    if not DATA_PATH.exists():
        print("data.json not found — run scrape.py first", file=sys.stderr)
        sys.exit(1)

    payload = json.loads(DATA_PATH.read_text())
    shows = payload["shows"]

    cache = load_cache()
    sp = build_spotify_client()

    print(f"Enriching {len(shows)} shows with music links…")
    changed = enrich(shows, sp, cache)
    print(f"  Looked up {changed} new bands")

    save_cache(cache)
    DATA_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    print(f"Updated {DATA_PATH}")


if __name__ == "__main__":
    main()
