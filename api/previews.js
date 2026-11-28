/**
 * Link previews for shared SF Music List URLs.
 *
 * The site is a single static page, so every shared link (?venue=…, ?artist=…,
 * ?show=…, ?view=all&date=…, ?q=…, ?view=radio…) would otherwise preview with
 * the same generic title. This rewrites <title>, description, Open Graph and
 * Twitter tags on the way through, using the live data.json / radio.json.
 */

const SITE_NAME = 'SF Music List';
const TZ = 'America/Los_Angeles';

function todayPacific() {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function shortDate(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US',
    { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const bandNames = show => (show.bands || []).map(b => (typeof b === 'string' ? b : b.name));

// Must match showId() in public/app.js
function showId(show) {
  return `show-${show.date}-${slugify(`${show.venue.name}-${bandNames(show)[0] || ''}`)}`;
}

function listText(items, max, more = ' + more') {
  return items.slice(0, max).join(', ') + (items.length > max ? more : '');
}

function clip(s, n = 280) {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

async function getJson(request, path) {
  const res = await fetch(new URL(path, request.url), { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

// Returns {title, description} for the URL, or null to leave the page alone
async function describe(request, url) {
  const p = url.searchParams;
  const today = todayPacific();
  const needsShows = ['show', 'venue', 'artist', 'date', 'q'].some(k => p.has(k));
  const shows = needsShows ? (await getJson(request, '/data.json')).shows || [] : [];
  const upcoming = shows.filter(s => s.date >= today);

  if (p.has('show')) {
    const show = shows.find(s => showId(s) === p.get('show'));
    if (!show) return null;
    const names = bandNames(show);
    const extras = [show.price, show.age, show.doors && `doors ${show.doors}`].filter(Boolean);
    return {
      title: `${listText(names, 2, ` + ${names.length - 2} more`)} at ${show.venue.name} — ${shortDate(show.date)}`,
      description: `${shortDate(show.date)} at ${show.venue.name}. Lineup: ${names.join(', ')}.` +
        (extras.length ? ` ${extras.join(' · ')}.` : ''),
    };
  }

  if (p.has('venue')) {
    const slug = p.get('venue');
    const end = addDays(today, 7);
    const here = upcoming.filter(s => slugify(s.venue.name) === slug && s.date <= end);
    if (!here.length) {
      const any = shows.find(s => slugify(s.venue.name) === slug);
      return any ? { title: `${any.venue.name} — ${SITE_NAME}`,
        description: `Upcoming shows at ${any.venue.name} in the Bay Area.` } : null;
    }
    const name = here[0].venue.name;
    const byDay = new Map();
    for (const s of here) byDay.set(s.date, [...(byDay.get(s.date) || []), ...bandNames(s)]);
    const lines = [...byDay].map(([d, b]) => `${shortDate(d)}: ${listText(b, 3)}`);
    return {
      title: `This week at ${name} — ${SITE_NAME}`,
      description: clip(lines.join(' · ')),
    };
  }

  if (p.has('artist')) {
    const artist = p.get('artist');
    const al = artist.toLowerCase();
    const theirs = upcoming.filter(s => bandNames(s).some(b => b.toLowerCase() === al));
    return {
      title: `${artist} — Bay Area shows on ${SITE_NAME}`,
      description: theirs.length
        ? clip(theirs.slice(0, 4).map(s => `${shortDate(s.date)} at ${s.venue.name}`).join(' · ') +
          (theirs.length > 4 ? ` + ${theirs.length - 4} more dates` : ''))
        : `See when ${artist} plays the San Francisco Bay Area and get notified about new shows.`,
    };
  }

  if (p.has('q')) {
    const q = p.get('q');
    const ql = q.toLowerCase();
    const hits = upcoming.filter(s =>
      s.venue.name.toLowerCase().includes(ql) || bandNames(s).some(b => b.toLowerCase().includes(ql)));
    return {
      title: `"${q}" — Bay Area shows on ${SITE_NAME}`,
      description: hits.length
        ? clip(`${hits.length} upcoming show${hits.length === 1 ? '' : 's'}: ` +
          hits.slice(0, 4).map(s => `${bandNames(s)[0]} (${shortDate(s.date)}, ${s.venue.name})`).join(' · '))
        : `Search Bay Area concert listings for "${q}".`,
    };
  }

  const view = p.get('view');
  if (p.has('date') && ['all', 'week', 'map'].includes(view)) {
    const date = p.get('date');
    const day = shows.filter(s => s.date === date);
    const venues = [...new Set(day.map(s => s.venue.name))];
    return {
      title: `Bay Area shows on ${shortDate(date)}${view === 'map' ? ' (map)' : ''} — ${SITE_NAME}`,
      description: day.length
        ? clip(`${day.length} show${day.length === 1 ? '' : 's'}${view === 'map' ? ' on the map' : ''}: ${listText(venues, 5)}`)
        : `Live music listings for ${shortDate(date)} in the San Francisco Bay Area.`,
    };
  }

  if (view === 'radio') {
    let description = 'Nonstop songs from the bands playing the San Francisco Bay Area this week.';
    let title = `SF Music List Radio`;
    try {
      const radio = await getJson(request, '/radio.json');
      const track = p.get('track');
      const artists = radio.artists || [];
      const hit = track && artists.find(a =>
        (a.spotifyTracks || []).some(t => t.id === track) || (a.youtube && a.youtube.id === track));
      if (hit) {
        const t = (hit.spotifyTracks || []).find(x => x.id === track);
        const song = t ? t.name : hit.youtube && hit.youtube.title;
        title = `${hit.name}${song ? ` – ${song}` : ''} on SF Music List Radio`;
        const s = (hit.shows || [])[0];
        description = s ? `${hit.name} plays ${s.venue} on ${shortDate(s.date)}. ${description}` : description;
      } else if (artists.length) {
        description = `${artists.length} artists playing the Bay Area this week, including ${listText(artists.map(a => a.name), 3, '')}.`;
      }
    } catch { /* keep the generic radio text */ }
    return { title, description };
  }

  if (view === 'week') {
    return { title: `This week's Bay Area shows — ${SITE_NAME}`,
      description: 'Every concert in San Francisco, Oakland, Berkeley and the Bay Area for the next 7 days.' };
  }
  if (view === 'map') {
    return { title: `Tonight's shows on the map — ${SITE_NAME}`,
      description: 'See which Bay Area venues have live music tonight, on a map.' };
  }
  if (view === 'venue') {
    return { title: `Bay Area shows by venue — ${SITE_NAME}`,
      description: 'This week\'s concerts at every San Francisco Bay Area venue, A to Z.' };
  }
  return null;
}

class SetContent {
  constructor(value) { this.value = value; }
  element(el) { el.setAttribute('content', this.value); }
}

export async function handlePreview(request) {
  const origin = await fetch(request);
  const url = new URL(request.url);
  const type = origin.headers.get('content-type') || '';
  if (request.method !== 'GET' || !url.search || !origin.ok || !type.includes('text/html')) {
    return origin;
  }

  let meta;
  try {
    meta = await describe(request, url);
  } catch (e) {
    console.error('preview:', e.message);
    return origin;
  }
  if (!meta) return origin;

  const { title, description } = meta;
  const shareUrl = url.toString();
  return new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent(title); } })
    .on('meta[name="description"]', new SetContent(description))
    .on('meta[property="og:title"]', new SetContent(title))
    .on('meta[property="og:description"]', new SetContent(description))
    .on('meta[property="og:url"]', new SetContent(shareUrl))
    .on('meta[name="twitter:title"]', new SetContent(title))
    .on('meta[name="twitter:description"]', new SetContent(description))
    .transform(origin);
}
