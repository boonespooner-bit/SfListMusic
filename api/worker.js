/**
 * SF Music List — Artist Subscription API
 * Cloudflare Worker with D1 database + Resend email
 *
 * Bindings (set in wrangler.toml / dashboard):
 *   DB            — D1 database
 *   RESEND_API_KEY — secret
 *   NOTIFY_SECRET  — secret (shared with GitHub Actions)
 *
 * Vars (wrangler.toml [vars]):
 *   SITE_URL      — https://sfmusiclist.com
 *   API_URL       — https://api.sfmusiclist.com
 *   FROM_EMAIL    — alerts@sfmusiclist.com
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Email ─────────────────────────────────────────────────────────────────────

async function sendEmail(env, to, subject, htmlBody) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: env.FROM_EMAIL, to, subject, html: htmlBody }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend ${res.status}: ${err}`);
  }
}

function confirmationEmail(env, bandName, confirmUrl) {
  return `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#222">
  <h2 style="color:#1db954">SF Music List</h2>
  <p>Click below to confirm your subscription. You'll get an email whenever
     <strong>${bandName}</strong> shows up in the Bay Area concert listings.</p>
  <p style="margin:2rem 0">
    <a href="${confirmUrl}" style="background:#1db954;color:#000;padding:12px 24px;
       border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">
      Confirm Subscription
    </a>
  </p>
  <p style="color:#888;font-size:12px">
    If you didn't request this, just ignore this email.<br>
    <a href="${env.SITE_URL}" style="color:#888">SF Music List</a>
  </p>
</div>`;
}

function notificationEmail(env, bandName, shows, unsubUrl) {
  const rows = shows.map(show => {
    const [y, m, d] = show.date.split('-').map(Number);
    const date = new Date(y, m - 1, d).toLocaleDateString('en-US',
      { weekday: 'long', month: 'long', day: 'numeric' });
    return `<li style="margin:6px 0"><strong>${date}</strong> at ${show.venue.name}</li>`;
  }).join('');
  return `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#222">
  <h2 style="color:#1db954">SF Music List</h2>
  <p><strong>${bandName}</strong> has new show(s) coming up in the Bay Area:</p>
  <ul style="padding-left:1.2rem">${rows}</ul>
  <p style="margin:2rem 0">
    <a href="${env.SITE_URL}" style="background:#1db954;color:#000;padding:12px 24px;
       border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">
      View on SF Music List
    </a>
  </p>
  <p style="color:#888;font-size:12px">
    <a href="${unsubUrl}" style="color:#888">Unsubscribe from ${bandName} alerts</a>
  </p>
</div>`;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleSubscribe(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const email     = (body.email || '').trim().toLowerCase();
  const bandName  = (body.band_name || '').trim();

  if (!email || !email.includes('@') || !email.includes('.'))
    return json({ error: 'Valid email required' }, 400);
  if (!bandName)
    return json({ error: 'Band name required' }, 400);

  const bandLower = bandName.toLowerCase();

  const existing = await env.DB
    .prepare('SELECT confirmed, confirm_token FROM subscriptions WHERE email=? AND band_lower=?')
    .bind(email, bandLower).first();

  let confirmToken;
  if (existing) {
    if (existing.confirmed) return json({ status: 'already_subscribed' });
    confirmToken = existing.confirm_token;      // resend same token
  } else {
    confirmToken      = generateToken();
    const unsubToken  = generateToken();
    await env.DB
      .prepare(`INSERT INTO subscriptions (email, band_name, band_lower, confirm_token, unsub_token)
                VALUES (?, ?, ?, ?, ?)`)
      .bind(email, bandName, bandLower, confirmToken, unsubToken).run();
  }

  const confirmUrl = `${env.API_URL}/api/confirm/${confirmToken}`;
  try {
    await sendEmail(env, email,
      `Confirm: notify me when ${bandName} plays the Bay Area`,
      confirmationEmail(env, bandName, confirmUrl)
    );
  } catch (e) {
    return json({ error: `Email failed: ${e.message}` }, 500);
  }

  return json({ status: 'confirmation_sent' });
}

async function handleConfirm(token, env) {
  const row = await env.DB
    .prepare('SELECT id, band_name FROM subscriptions WHERE confirm_token=?')
    .bind(token).first();
  if (!row) return html('Invalid or expired confirmation link.', 400);

  await env.DB.prepare('UPDATE subscriptions SET confirmed=1 WHERE id=?').bind(row.id).run();

  const band = encodeURIComponent(row.band_name);
  return Response.redirect(`${env.SITE_URL}?subscribed=${band}`, 302);
}

async function handleUnsubscribe(token, env) {
  const row = await env.DB
    .prepare('SELECT id, band_name FROM subscriptions WHERE unsub_token=?')
    .bind(token).first();
  if (!row) return html('Invalid unsubscribe link.', 400);

  await env.DB.prepare('DELETE FROM subscriptions WHERE id=?').bind(row.id).run();

  return html(`<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><title>Unsubscribed</title></head>
<body style="font-family:sans-serif;text-align:center;padding:4rem;background:#0d0d0f;color:#e8e8f0">
  <h2>You're unsubscribed</h2>
  <p>You'll no longer receive alerts for <strong>${row.band_name}</strong>.</p>
  <p><a href="${env.SITE_URL}" style="color:#1db954">Back to SF Music List</a></p>
</body></html>`);
}

async function handleNotify(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!env.NOTIFY_SECRET || auth !== `Bearer ${env.NOTIFY_SECRET}`)
    return json({ error: 'Unauthorized' }, 401);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const shows = payload.shows || [];
  const today = new Date().toISOString().slice(0, 10);

  // band_lower → list of future shows
  const bandShows = {};
  for (const show of shows) {
    if (show.date < today) continue;
    for (const b of (show.bands || [])) {
      const name = typeof b === 'string' ? b : b.name;
      const bl = name.toLowerCase().trim();
      if (!bl) continue;
      (bandShows[bl] = bandShows[bl] || []).push(show);
    }
  }

  const { results: subs } = await env.DB
    .prepare('SELECT id, email, band_name, band_lower, unsub_token FROM subscriptions WHERE confirmed=1')
    .all();

  let sent = 0;
  for (const sub of subs) {
    const matches = bandShows[sub.band_lower] || [];
    if (!matches.length) continue;

    // Filter to unnotified shows
    const newShows = [];
    for (const show of matches) {
      const vl = show.venue.name.toLowerCase().trim();
      const already = await env.DB
        .prepare('SELECT id FROM notified WHERE email=? AND band_lower=? AND show_date=? AND venue_lower=?')
        .bind(sub.email, sub.band_lower, show.date, vl).first();
      if (!already) newShows.push(show);
    }
    if (!newShows.length) continue;

    try {
      const unsubUrl = `${env.API_URL}/api/unsubscribe/${sub.unsub_token}`;
      await sendEmail(env, sub.email,
        `🎵 ${sub.band_name} has a new show in the Bay Area`,
        notificationEmail(env, sub.band_name, newShows, unsubUrl)
      );
      for (const show of newShows) {
        const vl = show.venue.name.toLowerCase().trim();
        await env.DB
          .prepare('INSERT OR IGNORE INTO notified (email, band_lower, show_date, venue_lower) VALUES (?,?,?,?)')
          .bind(sub.email, sub.band_lower, show.date, vl).run();
      }
      sent++;
    } catch (e) {
      console.error(`Notify error for ${sub.email}:`, e.message);
    }
  }

  return json({ sent });
}

// ── Router ────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (pathname === '/api/health')                         return json({ status: 'ok' });
    if (pathname === '/api/subscribe')                      return handleSubscribe(request, env);
    if (pathname.startsWith('/api/confirm/'))               return handleConfirm(pathname.slice(13), env);
    if (pathname.startsWith('/api/unsubscribe/'))           return handleUnsubscribe(pathname.slice(17), env);
    if (pathname === '/api/notify')                         return handleNotify(request, env);

    return new Response('Not found', { status: 404 });
  },
};
