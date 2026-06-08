#!/usr/bin/env python3
"""SF Music List — Artist Subscription API

Endpoints:
  POST /api/subscribe          {email, band_name} → sends confirmation email
  GET  /api/confirm/<token>    confirms subscription, redirects to site
  GET  /api/unsubscribe/<token> removes subscription
  POST /api/notify             called by GitHub Actions with show data; sends alerts
  GET  /api/health             health check

Environment variables:
  RESEND_API_KEY   — from resend.com
  NOTIFY_SECRET    — shared secret for /api/notify (set same in GitHub secret)
  SITE_URL         — https://sfmusiclist.com
  API_URL          — https://api.sfmusiclist.com
  FROM_EMAIL       — alerts@sfmusiclist.com  (must be a verified Resend domain)
  DB_PATH          — /data/subscriptions.db  (Render persistent disk)
  CORS_ORIGINS     — comma-separated allowed origins
"""

import json
import os
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import resend
from flask import Flask, jsonify, redirect, request
from flask_cors import CORS

app = Flask(__name__)

_origins = os.environ.get("CORS_ORIGINS", "https://sfmusiclist.com,http://localhost:8080").split(",")
CORS(app, origins=[o.strip() for o in _origins])

DB_PATH       = Path(os.environ.get("DB_PATH", "/data/subscriptions.db"))
SITE_URL      = os.environ.get("SITE_URL",   "https://sfmusiclist.com")
API_URL       = os.environ.get("API_URL",    "https://api.sfmusiclist.com")
FROM_EMAIL    = os.environ.get("FROM_EMAIL", "alerts@sfmusiclist.com")
NOTIFY_SECRET = os.environ.get("NOTIFY_SECRET", "")

resend.api_key = os.environ.get("RESEND_API_KEY", "")


# ── Database ──────────────────────────────────────────────────────────────────

def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_db() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS subscriptions (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                email         TEXT NOT NULL,
                band_name     TEXT NOT NULL,
                band_lower    TEXT NOT NULL,
                confirmed     INTEGER DEFAULT 0,
                confirm_token TEXT UNIQUE NOT NULL,
                unsub_token   TEXT UNIQUE NOT NULL,
                created_at    TEXT DEFAULT (datetime('now'))
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_email_band
                ON subscriptions (email, band_lower);
            CREATE INDEX IF NOT EXISTS idx_band_lower
                ON subscriptions (band_lower);

            CREATE TABLE IF NOT EXISTS notified (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                email       TEXT NOT NULL,
                band_lower  TEXT NOT NULL,
                show_date   TEXT NOT NULL,
                venue_lower TEXT NOT NULL,
                notified_at TEXT DEFAULT (datetime('now')),
                UNIQUE(email, band_lower, show_date, venue_lower)
            );
        """)


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


# ── Email helpers ─────────────────────────────────────────────────────────────

def send_confirmation(email: str, band_name: str, confirm_token: str):
    confirm_url = f"{API_URL}/api/confirm/{confirm_token}"
    resend.Emails.send({
        "from": FROM_EMAIL,
        "to": email,
        "subject": f"Confirm: notify me when {band_name} plays the Bay Area",
        "html": f"""
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#222">
  <h2 style="color:#1db954">SF Music List</h2>
  <p>Click below to confirm your subscription.
     You'll get an email whenever <strong>{band_name}</strong>
     shows up in the Bay Area concert listings.</p>
  <p style="margin:2rem 0">
    <a href="{confirm_url}"
       style="background:#1db954;color:#000;padding:12px 24px;border-radius:8px;
              text-decoration:none;font-weight:700;font-size:15px">
      Confirm Subscription
    </a>
  </p>
  <p style="color:#888;font-size:12px">
    If you didn't request this, just ignore this email.<br>
    <a href="{SITE_URL}" style="color:#888">SF Music List</a>
  </p>
</div>""",
    })


def send_notification(email: str, band_name: str, shows: list, unsub_token: str):
    unsub_url = f"{API_URL}/api/unsubscribe/{unsub_token}"
    rows = ""
    for show in shows:
        try:
            y, m, d = map(int, show["date"].split("-"))
            from datetime import date as date_cls
            date_str = date_cls(y, m, d).strftime("%A, %B %-d")
        except Exception:
            date_str = show["date"]
        venue = show["venue"]["name"]
        rows += f"<li style='margin:6px 0'><strong>{date_str}</strong> at {venue}</li>"

    resend.Emails.send({
        "from": FROM_EMAIL,
        "to": email,
        "subject": f"🎵 {band_name} has a new show in the Bay Area",
        "html": f"""
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#222">
  <h2 style="color:#1db954">SF Music List</h2>
  <p><strong>{band_name}</strong> has new show(s) coming up in the Bay Area:</p>
  <ul style="padding-left:1.2rem">{rows}</ul>
  <p style="margin:2rem 0">
    <a href="{SITE_URL}"
       style="background:#1db954;color:#000;padding:12px 24px;border-radius:8px;
              text-decoration:none;font-weight:700;font-size:15px">
      View on SF Music List
    </a>
  </p>
  <p style="color:#888;font-size:12px">
    <a href="{unsub_url}" style="color:#888">Unsubscribe from {band_name} alerts</a>
  </p>
</div>""",
    })


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "db": str(DB_PATH)})


@app.route("/api/subscribe", methods=["POST"])
def subscribe():
    data = request.get_json(silent=True) or {}
    email     = (data.get("email") or "").strip().lower()
    band_name = (data.get("band_name") or "").strip()

    if not email or "@" not in email or "." not in email.split("@")[-1]:
        return jsonify({"error": "Valid email required"}), 400
    if not band_name:
        return jsonify({"error": "Band name required"}), 400

    band_lower    = band_name.lower()
    confirm_token = secrets.token_urlsafe(32)
    unsub_token   = secrets.token_urlsafe(32)

    try:
        with get_db() as db:
            existing = db.execute(
                "SELECT confirmed, confirm_token FROM subscriptions WHERE email=? AND band_lower=?",
                (email, band_lower)
            ).fetchone()

            if existing:
                if existing["confirmed"]:
                    return jsonify({"status": "already_subscribed"})
                # Resend the original confirmation
                confirm_token = existing["confirm_token"]
            else:
                db.execute(
                    """INSERT INTO subscriptions
                       (email, band_name, band_lower, confirm_token, unsub_token)
                       VALUES (?, ?, ?, ?, ?)""",
                    (email, band_name, band_lower, confirm_token, unsub_token)
                )
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    try:
        send_confirmation(email, band_name, confirm_token)
    except Exception as e:
        return jsonify({"error": f"Email failed: {e}"}), 500

    return jsonify({"status": "confirmation_sent"})


@app.route("/api/confirm/<token>")
def confirm(token):
    with get_db() as db:
        row = db.execute(
            "SELECT id, band_name FROM subscriptions WHERE confirm_token=?", (token,)
        ).fetchone()
        if not row:
            return "Invalid or expired confirmation link.", 400
        db.execute("UPDATE subscriptions SET confirmed=1 WHERE id=?", (row["id"],))
    safe_band = row["band_name"].replace('"', '')
    return redirect(f"{SITE_URL}?subscribed={safe_band}", 302)


@app.route("/api/unsubscribe/<token>")
def unsubscribe_route(token):
    with get_db() as db:
        row = db.execute(
            "SELECT id, band_name FROM subscriptions WHERE unsub_token=?", (token,)
        ).fetchone()
        if not row:
            return "Invalid unsubscribe link.", 400
        db.execute("DELETE FROM subscriptions WHERE id=?", (row["id"],))
    return f"""<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><title>Unsubscribed — SF Music List</title></head>
<body style="font-family:sans-serif;text-align:center;padding:4rem;background:#0d0d0f;color:#e8e8f0">
  <h2>You're unsubscribed</h2>
  <p>You'll no longer receive alerts for <strong>{row['band_name']}</strong>.</p>
  <p><a href="{SITE_URL}" style="color:#1db954">Back to SF Music List</a></p>
</body></html>"""


@app.route("/api/notify", methods=["POST"])
def notify():
    # Verify secret
    auth = request.headers.get("Authorization", "")
    if not NOTIFY_SECRET or auth != f"Bearer {NOTIFY_SECRET}":
        return jsonify({"error": "Unauthorized"}), 401

    payload = request.get_json(silent=True, force=True) or {}
    shows = payload.get("shows", [])
    if not shows:
        return jsonify({"sent": 0, "reason": "no shows in payload"})

    today = datetime.now(timezone.utc).date().isoformat()

    # band_lower → list of future shows
    band_shows: dict[str, list] = {}
    for show in shows:
        if show.get("date", "") < today:
            continue
        for band in show.get("bands", []):
            bname = band if isinstance(band, str) else band.get("name", "")
            bl = bname.lower().strip()
            if bl:
                band_shows.setdefault(bl, []).append(show)

    emails_sent = 0
    with get_db() as db:
        subs = db.execute(
            "SELECT id, email, band_name, band_lower, unsub_token FROM subscriptions WHERE confirmed=1"
        ).fetchall()

        for sub in subs:
            bl      = sub["band_lower"]
            matches = band_shows.get(bl, [])
            if not matches:
                continue

            # Filter to shows not yet notified
            new_shows = []
            for show in matches:
                venue_lower = show["venue"]["name"].lower().strip()
                already = db.execute(
                    "SELECT id FROM notified WHERE email=? AND band_lower=? AND show_date=? AND venue_lower=?",
                    (sub["email"], bl, show["date"], venue_lower)
                ).fetchone()
                if not already:
                    new_shows.append(show)

            if not new_shows:
                continue

            try:
                send_notification(sub["email"], sub["band_name"], new_shows, sub["unsub_token"])
                for show in new_shows:
                    venue_lower = show["venue"]["name"].lower().strip()
                    db.execute(
                        "INSERT OR IGNORE INTO notified (email, band_lower, show_date, venue_lower) VALUES (?,?,?,?)",
                        (sub["email"], bl, show["date"], venue_lower)
                    )
                emails_sent += 1
                print(f"  Notified {sub['email']} → {sub['band_name']} ({len(new_shows)} show(s))", flush=True)
            except Exception as e:
                print(f"  Email error {sub['email']}: {e}", flush=True)

    return jsonify({"sent": emails_sent})


# ── Startup ───────────────────────────────────────────────────────────────────

init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)), debug=False)
