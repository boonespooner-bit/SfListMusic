#!/usr/bin/env python3
"""Builds public/radio.json — the "SF Music List Radio" daily playlist.

Selects the top 90 artists by show count in the next 7 days, fetches their
Spotify top tracks and a YouTube video, caches results in radio_cache.json,
and writes a compact radio.json for the frontend jukebox player.

Env vars required:
  SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET — Spotify Web API
  YOUTUBE_API_KEY                            — YouTube Data API v3
"""

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
import spotipy
from spotipy.oauth2 import SpotifyClientCredentials

ROOT       = Path(__file__).parent.parent
DATA_PATH  = ROOT / "public" / "data.json"
RADIO_PATH = ROOT / "public" / "radio.json"
CACHE_PATH = ROOT / "public" / "radio_cache.json"

MAX_ARTISTS       = 90
SPOTIFY_TRACKS    = 2
CACHE_TTL_DAYS    = 30    # refresh a band's tracks/video no more often than this
YOUTUBE_QUOTA_CAP = 80    # search.list is 100 units; 80 calls ≈ 8000 units


def load_json(path: Path, default):
    if path.exists():
        return json.loads(path.read_text())
    return default


def save_json(path: Path, obj):
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False))


def band_key(name: str) -> str:
    return name.lower().strip()


def spotify_artist_id_from_url(url: str | None) -> str | None:
    if not url or "spotify.com/artist/" not in url:
        return None
    return url.rsplit("/", 1)[-1].split("?")[0]


def top_artists_this_week(shows: list[dict]) -> list[dict]:
    """Rank artists by show count over the next 7 days.
    Returns list of {name, spotifyArtistId, showCount, shows: [{date, venue}]}."""
    today = datetime.now(timezone.utc).date()
    end   = today + timedelta(days=7)

    tally: dict[str, dict] = {}
    for show in shows:
        try:
            d = datetime.strptime(show["date"], "%Y-%m-%d").date()
        except (KeyError, ValueError):
            continue
        if d < today or d > end:
            continue
        venue = (show.get("venue") or {}).get("name") or ""
        for b in show.get("bands", []):
            name = b.get("name") if isinstance(b, dict) else b
            if not name:
                continue
            key = band_key(name)
            entry = tally.setdefault(key, {
                "name": name,
                "spotifyArtistId": spotify_artist_id_from_url(
                    b.get("spotifyUrl") if isinstance(b, dict) else None),
                "showCount": 0,
                "shows": [],
            })
            entry["showCount"] += 1
            entry["shows"].append({"date": show["date"], "venue": venue})
            # Keep the Spotify ID if any variant of the entry had one
            if not entry["spotifyArtistId"] and isinstance(b, dict):
                entry["spotifyArtistId"] = spotify_artist_id_from_url(b.get("spotifyUrl"))

    ranked = sorted(tally.values(),
                    key=lambda e: (-e["showCount"], e["name"].lower()))
    return ranked[:MAX_ARTISTS]


# ── Spotify ──────────────────────────────────────────────────────────────────

def spotify_top_tracks(sp, artist_id: str, artist_name: str) -> list[dict]:
    # Preferred: the top-tracks endpoint. Some API apps get 403 here even
    # though search works, so fall back to a popularity-ranked track search.
    try:
        res = sp.artist_top_tracks(artist_id, country="US")
        out = [{"id": t["id"], "name": t["name"]}
               for t in res.get("tracks", [])[:SPOTIFY_TRACKS]]
        if out:
            return out
    except Exception as e:
        print(f"    top-tracks blocked for {artist_name} ({e}); using track search", flush=True)
    return spotify_search_tracks(sp, artist_id, artist_name)


def spotify_search_tracks(sp, artist_id: str, artist_name: str) -> list[dict]:
    try:
        res = sp.search(q=f'artist:"{artist_name}"', type="track", limit=10, market="US")
        items = res.get("tracks", {}).get("items", [])
        # Keep only tracks actually by this artist (search can match covers/features)
        out = []
        for t in items:
            artist_ids = {a.get("id") for a in t.get("artists", [])}
            if artist_id and artist_id not in artist_ids:
                continue
            out.append({"id": t["id"], "name": t["name"]})
            if len(out) >= SPOTIFY_TRACKS:
                break
        # If strict matching found nothing (e.g. stale artist id), take top results
        if not out and items:
            out = [{"id": t["id"], "name": t["name"]} for t in items[:SPOTIFY_TRACKS]]
        return out
    except Exception as e:
        print(f"    track search failed for {artist_name}: {e}", flush=True)
        return []


# ── YouTube ──────────────────────────────────────────────────────────────────

YT_SEARCH = "https://www.googleapis.com/youtube/v3/search"

def youtube_search(api_key: str, artist: str) -> dict | None:
    """Return {id, title} for the top video match, or None."""
    try:
        r = requests.get(YT_SEARCH, params={
            "part": "snippet",
            "q": f"{artist} official audio",
            "type": "video",
            "videoEmbeddable": "true",
            "maxResults": 1,
            "key": api_key,
        }, timeout=10)
        if r.status_code == 403:
            print(f"    youtube 403 (quota?) for {artist}: {r.text[:200]}", flush=True)
            return "QUOTA_EXCEEDED"  # sentinel
        r.raise_for_status()
        items = r.json().get("items") or []
        if not items:
            return None
        top = items[0]
        return {"id": top["id"]["videoId"], "title": top["snippet"]["title"]}
    except Exception as e:
        print(f"    youtube search failed for {artist}: {e}", flush=True)
        return None


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    if not DATA_PATH.exists():
        print("data.json missing — run scrape.py first", file=sys.stderr)
        sys.exit(1)

    payload = json.loads(DATA_PATH.read_text())
    shows   = payload.get("shows", [])

    ranked = top_artists_this_week(shows)
    print(f"Top {len(ranked)} artists this week (of {len(shows)} shows)", flush=True)

    cache = load_json(CACHE_PATH, {})
    print(f"radio_cache has {len(cache)} entries", flush=True)

    # Spotify client (Client Credentials — no user auth needed for top-tracks)
    sp = None
    cid = os.environ.get("SPOTIFY_CLIENT_ID")
    csec = os.environ.get("SPOTIFY_CLIENT_SECRET")
    if cid and csec:
        auth = SpotifyClientCredentials(client_id=cid, client_secret=csec)
        sp = spotipy.Spotify(auth_manager=auth, retries=0, requests_timeout=8)
    else:
        print("  no Spotify credentials — skipping Spotify enrichment", flush=True)

    yt_key = os.environ.get("YOUTUBE_API_KEY")
    if not yt_key:
        print("  no YOUTUBE_API_KEY — skipping YouTube enrichment", flush=True)

    today = datetime.now(timezone.utc).date()
    yt_calls = 0
    yt_quota_dead = False

    for i, a in enumerate(ranked, 1):
        key    = band_key(a["name"])
        cached = cache.get(key, {})
        fresh  = False
        if cached.get("cachedAt"):
            try:
                age = (today - datetime.strptime(cached["cachedAt"], "%Y-%m-%d").date()).days
                fresh = age < CACHE_TTL_DAYS
            except ValueError:
                pass

        # Spotify tracks
        tracks = cached.get("spotifyTracks") or []
        if sp and (not fresh or not tracks):
            if a.get("spotifyArtistId"):
                tracks = spotify_top_tracks(sp, a["spotifyArtistId"], a["name"])
            else:
                tracks = spotify_search_tracks(sp, None, a["name"])

        # YouTube video (respect daily quota cap)
        yt = cached.get("youtube")
        if yt_key and not yt_quota_dead and (not fresh or not yt) and yt_calls < YOUTUBE_QUOTA_CAP:
            result = youtube_search(yt_key, a["name"])
            yt_calls += 1
            if result == "QUOTA_EXCEEDED":
                yt_quota_dead = True
            elif result:
                yt = result

        cache[key] = {
            "name": a["name"],
            "spotifyTracks": tracks,
            "youtube": yt,
            "cachedAt": today.isoformat(),
        }

        if i % 20 == 0:
            print(f"  processed {i}/{len(ranked)} (yt calls: {yt_calls})", flush=True)
            save_json(CACHE_PATH, cache)

    save_json(CACHE_PATH, cache)
    print(f"YouTube API calls this run: {yt_calls}", flush=True)

    # Build radio.json — only include artists with at least one playable item
    week_start = today.isoformat()
    week_end   = (today + timedelta(days=7)).isoformat()

    entries = []
    for a in ranked:
        c = cache.get(band_key(a["name"]), {})
        tracks = c.get("spotifyTracks") or []
        yt     = c.get("youtube")
        if not tracks and not yt:
            continue
        entries.append({
            "name": a["name"],
            "showCount": a["showCount"],
            "shows": a["shows"][:3],
            "spotifyTracks": tracks,
            "youtube": yt,
        })

    radio = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "weekStart": week_start,
        "weekEnd":   week_end,
        "artists":   entries,
    }
    save_json(RADIO_PATH, radio)

    total_tracks = sum(len(e["spotifyTracks"]) for e in entries)
    total_videos = sum(1 for e in entries if e.get("youtube"))
    print(f"Wrote {RADIO_PATH}: {len(entries)} artists, "
          f"{total_tracks} Spotify tracks, {total_videos} YouTube videos", flush=True)


if __name__ == "__main__":
    main()
