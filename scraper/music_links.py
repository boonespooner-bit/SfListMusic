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


def spotify_lookup(sp: spotipy.Spotify, band: str) -> str | None:
    """Return the Spotify artist page URL. (top-tracks endpoint is restricted
    under Client Credentials flow as of late 2024, so we link to the artist
    page — Spotify auto-plays the top track from there.)"""
    try:
        results = sp.search(q=f"artist:{band}", type="artist", limit=1)
        items = results.get("artists", {}).get("items", [])
        if items:
            return items[0]["external_urls"]["spotify"]
    except Exception as e:
        print(f"    Spotify error for '{band}': {e}")
    return None


def youtube_url(band: str) -> str:
    query = "+".join(band.split())
    return f"https://www.youtube.com/results?search_query={query}"


def enrich(shows: list[dict], sp: spotipy.Spotify | None, cache: dict) -> int:
    changed = 0
    seen: set[str] = set()
    total = sum(len(s.get("bands", [])) for s in shows)
    processed = 0

    for show in shows:
        for band in show.get("bands", []):
            key = band.lower().strip()
            if key in seen:
                continue
            seen.add(key)
            processed += 1
            if processed % 50 == 0:
                print(f"  Progress: {processed}/{total} unique bands processed ({changed} new lookups)", flush=True)

            if key in cache:
                show["spotifyUrl"] = cache[key].get("spotifyUrl")
                show["youtubeUrl"] = cache[key].get("youtubeUrl")
                continue

            spotify_url = None
            if sp:
                spotify_url = spotify_lookup(sp, band)

            yt_url = youtube_url(band) if not spotify_url else youtube_url(band)

            cache[key] = {"spotifyUrl": spotify_url, "youtubeUrl": yt_url}
            show["spotifyUrl"] = spotify_url
            show["youtubeUrl"] = yt_url
            changed += 1
            print(f"    {band}: spotify={'yes' if spotify_url else 'no'}", flush=True)

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
