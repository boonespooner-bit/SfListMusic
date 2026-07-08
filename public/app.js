'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
// Set this to your Render API service URL once deployed.
const API_BASE = 'https://api.sfmusiclist.com';

const SYMBOL_TIPS = {
  '*': 'All bands deserve 3 stars',
  '~': 'Will probably sell out',
  '@': 'Mosh pit warning',
  '^': 'Under 21 must pay more',
  '#': 'No ins/outs',
};

const SPOTIFY_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>`;
const VENUE_ICON = `<svg class="venue-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>`;
const TICKET_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M22 10V6c0-1.11-.9-2-2-2H4c-1.1 0-1.99.89-1.99 2v4c1.1 0 1.99.9 1.99 2s-.89 2-2 2v4c0 1.11.89 2 2 2h16c1.1 0 2-.89 2-2v-4c-1.1 0-2-.9-2-2s.9-2 2-2zm-9 7.5h-2v-2h2v2zm0-4.5h-2v-2h2v2zm0-4.5h-2v-2h2v2z"/></svg>`;
const YT_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M23.495 6.205a3.007 3.007 0 0 0-2.088-2.088c-1.87-.501-9.396-.501-9.396-.501s-7.507-.01-9.396.501A3.007 3.007 0 0 0 .527 6.205a31.247 31.247 0 0 0-.522 5.805 31.247 31.247 0 0 0 .522 5.783 3.007 3.007 0 0 0 2.088 2.088c1.868.502 9.396.502 9.396.502s7.506 0 9.396-.502a3.007 3.007 0 0 0 2.088-2.088 31.247 31.247 0 0 0 .5-5.783 31.247 31.247 0 0 0-.5-5.805zM9.609 15.601V8.408l6.264 3.602z"/></svg>`;

let allShows = [];
let venueCoords = {};
let venueWebsites = {};
let currentView = 'today';
let searchQuery = '';
let leafletMap = null;
let mapDate = null;  // ISO date currently shown on the map

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadData() {
  try {
    const [showRes, coordRes, sitesRes] = await Promise.all([
      fetch('data.json'),
      fetch('venue_coords.json').catch(() => null),
      fetch('venue_websites.json').catch(() => null),
    ]);
    if (!showRes.ok) throw new Error(`HTTP ${showRes.status}`);
    const payload = await showRes.json();
    allShows = payload.shows || [];
    if (coordRes && coordRes.ok) venueCoords = await coordRes.json();
    if (sitesRes && sitesRes.ok) {
      const sitesData = await sitesRes.json();
      venueWebsites = sitesData.venues || sitesData;
    }
    const updated = new Date(payload.updated);
    document.getElementById('updated-note').textContent =
      `Updated ${updated.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;
    render();
    injectEventSchema();
  } catch (e) {
    document.getElementById('main').innerHTML = `
      <div class="empty-state">
        <h2>Could not load shows</h2>
        <p>${e.message}</p>
      </div>`;
  }
}

function injectEventSchema() {
  const today = todayISO();
  // Emit upcoming shows (next 30 days) as MusicEvent structured data for Google
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + 30);
  const cutoffISO = cutoff.toISOString().slice(0, 10);

  const events = allShows
    .filter(s => s.date >= today && s.date <= cutoffISO)
    .map(show => {
      const performers = show.bands.map(b => ({
        '@type': 'MusicGroup',
        name: typeof b === 'string' ? b : b.name,
      }));
      const event = {
        '@type': 'MusicEvent',
        name: show.bands.map(b => typeof b === 'string' ? b : b.name).join(', '),
        startDate: show.date,
        location: {
          '@type': 'MusicVenue',
          name: show.venue.name,
          address: { '@type': 'PostalAddress', addressRegion: 'CA', addressCountry: 'US' },
        },
        performer: performers,
        eventStatus: 'https://schema.org/EventScheduled',
        eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
      };
      if (show.price) event.offers = { '@type': 'Offer', price: show.price, priceCurrency: 'USD' };
      return event;
    });

  if (!events.length) return;
  const script = document.createElement('script');
  script.type = 'application/ld+json';
  script.textContent = JSON.stringify({ '@context': 'https://schema.org', '@graph': events });
  document.head.appendChild(script);
}

// ── Filtering ─────────────────────────────────────────────────────────────────

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function weekEnd() {
  const d = new Date();
  d.setDate(d.getDate() + 6);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function filterShows(shows) {
  const today = todayISO();
  let filtered = shows.filter(s => s.date >= today);

  if (currentView === 'today') {
    filtered = filtered.filter(s => s.date === today);
    if (!filtered.length) {
      // Fall back to next available date
      const next = shows.find(s => s.date >= today);
      if (next) filtered = shows.filter(s => s.date === next.date);
    }
  } else if (currentView === 'week') {
    const end = weekEnd();
    filtered = filtered.filter(s => s.date <= end);
  }

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(s =>
      s.bands.some(b => (typeof b === 'string' ? b : b.name).toLowerCase().includes(q)) ||
      s.venue.name.toLowerCase().includes(q)
    );
  }

  return filtered;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function groupByDate(shows) {
  const map = new Map();
  for (const show of shows) {
    if (!map.has(show.date)) map.set(show.date, []);
    map.get(show.date).push(show);
  }
  return map;
}

function formatDateHeader(isoDate, dayName) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  const label = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  return { label, isToday: isoDate === todayISO() };
}

function buyTicketsUrl(show) {
  const name = (show.venue.name || '').toLowerCase();
  for (const [key, url] of Object.entries(venueWebsites)) {
    if (name.includes(key)) return url;
  }
  const bandName = show.bands.length
    ? (typeof show.bands[0] === 'string' ? show.bands[0] : show.bands[0].name)
    : '';
  const q = encodeURIComponent(`"${show.venue.name}" tickets ${bandName}`);
  return `https://www.google.com/search?q=${q}`;
}

function showId(show) {
  // Deterministic ID for scroll-targeting from the map view
  const firstBand = show.bands.length
    ? (typeof show.bands[0] === 'string' ? show.bands[0] : show.bands[0].name)
    : '';
  const slug = (show.venue.name + '-' + firstBand)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `show-${show.date}-${slug}`;
}

function bandMusicBtns(band) {
  const parts = [];
  if (band.spotifyUrl) {
    parts.push(`<a class="btn-spotify" href="${band.spotifyUrl}" target="_blank" rel="noopener">${SPOTIFY_ICON} Spotify</a>`);
  }
  if (band.youtubeUrl) {
    parts.push(`<a class="btn-youtube" href="${band.youtubeUrl}" target="_blank" rel="noopener">${YT_ICON} YouTube</a>`);
  }
  return parts.length ? `<div class="music-btns">${parts.join('')}</div>` : '';
}

function renderSymbols(symbols) {
  if (!symbols || !symbols.length) return '';
  return `<span class="symbols">${symbols.map(s =>
    `<span class="symbol" title="${SYMBOL_TIPS[s] || s}">${s}</span>`
  ).join('')}</span>`;
}

function renderCard(show) {
  const bandsHtml = show.bands.map(b => {
    // Bands may be strings (legacy) or {name, spotifyUrl, youtubeUrl}.
    const band = typeof b === 'string' ? { name: b } : b;
    return `
      <div class="band-item">
        <span class="band-name band-link" data-band="${escHtml(band.name)}">${escHtml(band.name)}</span>
        ${bandMusicBtns(band)}
      </div>`;
  }).join('');

  const venueName = escHtml(show.venue.name);
  const venueInner = `${VENUE_ICON}<span>${venueName}</span>`;
  const venueHtml = show.venue.url
    ? `<a class="venue-link" href="https://jon.luini.com/thelist/${show.venue.url}" target="_blank" rel="noopener">${venueInner}</a>`
    : `<span class="venue-link">${venueInner}</span>`;

  const pills = [];
  if (show.age)   pills.push(`<span class="meta-pill pill-age">${escHtml(show.age)}</span>`);
  if (show.price) pills.push(`<span class="meta-pill pill-price">${escHtml(show.price)}</span>`);
  if (show.doors || show.show) {
    const t = [show.doors && `Doors ${show.doors}`, show.show && `Show ${show.show}`].filter(Boolean).join(' · ');
    pills.push(`<span class="meta-pill pill-time">${escHtml(t)}</span>`);
  }
  if (show.notes) pills.push(`<span class="meta-pill pill-note">${escHtml(show.notes)}</span>`);

  const buyUrl = buyTicketsUrl(show);
  const buyBtn = `<a class="btn-buy" href="${buyUrl}" target="_blank" rel="noopener">${TICKET_ICON} Buy Tickets</a>`;

  return `
    <div class="show-card" id="${showId(show)}">
      <div class="bands-list">${bandsHtml}</div>
      <div class="card-meta">
        ${venueHtml}
        ${pills.join('')}
        ${renderSymbols(show.symbols)}
        <span class="card-buy">${buyBtn}</span>
      </div>
    </div>`;
}

function render() {
  const shows = filterShows(allShows);
  const main = document.getElementById('main');

  if (!shows.length) {
    hideWeekDaySelector();
    hideAllWeekSelector();
    hideVenueView();
    const msg = currentView === 'today'
      ? 'No shows listed for today.'
      : 'No shows found.';
    main.innerHTML = `<div class="empty-state"><h2>${msg}</h2><p>Try "All Shows" to browse the full calendar.</p></div>`;
    return;
  }

  const grouped = groupByDate(shows);
  let html = '';
  let lastMonth = '';

  for (const [date, dateShows] of grouped) {
    const { label, isToday } = formatDateHeader(date, dateShows[0].dayName);
    const month = label.split(' ').slice(0, 1).join('');

    if (month !== lastMonth && currentView !== 'today') {
      const [year, m] = date.split('-');
      const monthName = new Date(+year, +m - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
      html += `<div class="month-divider">${monthName}</div>`;
      lastMonth = month;
    }

    html += `
      <div class="date-group" id="date-${date}">
        <div class="date-header">
          <span class="date-day">${label}</span>
          ${isToday ? '<span class="date-today-badge">Today</span>' : ''}
          <span class="date-label">${dateShows[0].dayName || ''}</span>
        </div>
        ${dateShows.map(renderCard).join('')}
      </div>`;
  }

  main.innerHTML = html;

  if (currentView === 'week') {
    renderWeekDaySelector([...grouped.keys()]);
    hideAllWeekSelector();
  } else if (currentView === 'all') {
    hideWeekDaySelector();
    renderAllWeekSelector([...grouped.keys()]);
    // Scroll to today (or nearest future date) on initial load
    const todayEl = document.getElementById(`date-${todayISO()}`);
    if (todayEl) todayEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    hideWeekDaySelector();
    hideAllWeekSelector();
  }
}

// ── Week day selector ─────────────────────────────────────────────────────────

function renderWeekDaySelector(weekDates) {
  const sel = document.getElementById('week-day-selector');
  if (!weekDates || !weekDates.length) {
    sel.classList.remove('active');
    document.body.classList.remove('week-view');
    sel.innerHTML = '';
    return;
  }

  document.body.classList.add('week-view');
  sel.classList.add('active');

  const showDates = new Set(weekDates);

  // Build Mon–Sun for the current week window (today through today+6)
  const today = todayISO();
  const buttons = weekDates.map(isoDate => {
    const [year, month, day] = isoDate.split('-').map(Number);
    const d = new Date(year, month - 1, day);
    const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
    const dayNum  = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const isToday = isoDate === today;
    const label   = isToday ? `Today · ${dayNum}` : `${dayName} · ${dayNum}`;
    return `<button class="week-day-btn" data-date="${isoDate}">${label}</button>`;
  });

  sel.innerHTML = buttons.join('');

  sel.querySelectorAll('.week-day-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(`date-${btn.dataset.date}`);
      if (!target) return;
      sel.querySelectorAll('.week-day-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // Scroll the bar so the first button is visible at the left edge on load
  sel.scrollLeft = 0;
}

function hideWeekDaySelector() {
  const sel = document.getElementById('week-day-selector');
  sel.classList.remove('active');
  sel.innerHTML = '';
  document.body.classList.remove('week-view');
}

// ── All-shows week selector ───────────────────────────────────────────────────

function weekStartISO(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dow = date.getDay(); // 0=Sun
  date.setDate(date.getDate() - (dow === 0 ? 6 : dow - 1)); // rewind to Monday
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function weekRangeLabel(mondayISO) {
  const [y, m, d] = mondayISO.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const end   = new Date(y, m - 1, d + 6);
  const startFmt = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const endFmt   = end.toLocaleDateString('en-US',
    start.getMonth() === end.getMonth() ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
  return `${startFmt}–${endFmt}`;
}

function renderAllWeekSelector(sortedDates) {
  const sel = document.getElementById('all-week-selector');
  if (!sortedDates.length) { hideAllWeekSelector(); return; }

  document.body.classList.add('all-view');
  sel.classList.add('active');

  // Map: weekStartISO → first date in that week that has shows
  const weeks = new Map();
  for (const date of sortedDates) {
    const ws = weekStartISO(date);
    if (!weeks.has(ws)) weeks.set(ws, date);
  }

  const todayWeek = weekStartISO(todayISO());

  const buttons = [...weeks.entries()].map(([ws, firstDate]) => {
    const label   = weekRangeLabel(ws);
    const current = ws === todayWeek ? ' active' : '';
    return `<button class="week-day-btn${current}" data-date="${firstDate}" data-week="${ws}">${label}</button>`;
  });

  sel.innerHTML = buttons.join('');

  sel.querySelectorAll('.week-day-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(`date-${btn.dataset.date}`);
      if (!target) return;
      sel.querySelectorAll('.week-day-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // On load, scroll the bar so the active (current) week button is centered
  const activeBtn = sel.querySelector('.week-day-btn.active');
  if (activeBtn) activeBtn.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'center' });
}

function hideAllWeekSelector() {
  const sel = document.getElementById('all-week-selector');
  sel.classList.remove('active');
  sel.innerHTML = '';
  document.body.classList.remove('all-view');
}

// ── Map view ──────────────────────────────────────────────────────────────────

function mapAvailableDates() {
  const dates = [...new Set(allShows.map(s => s.date))].sort();
  return dates;
}

function formatMapDayLabel(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  const isToday = isoDate === todayISO();
  const formatted = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return isToday ? `Today · ${formatted}` : formatted;
}

function updateMapDayNav() {
  const dates = mapAvailableDates();
  const idx = dates.indexOf(mapDate);
  document.getElementById('map-day-label').textContent = formatMapDayLabel(mapDate);
  document.getElementById('map-prev-day').disabled = idx <= 0;
  document.getElementById('map-next-day').disabled = idx >= dates.length - 1;
}

function plotMapMarkers() {
  // Remove existing markers
  leafletMap.eachLayer(l => { if (l instanceof L.Marker) leafletMap.removeLayer(l); });

  const dateShows = allShows.filter(s => s.date === mapDate);
  const byVenue = new Map();
  for (const show of dateShows) {
    const key = show.venue.url || show.venue.name;
    if (!byVenue.has(key)) byVenue.set(key, { venue: show.venue, shows: [] });
    byVenue.get(key).shows.push(show);
  }

  const dot = L.divIcon({ className: 'venue-dot', iconSize: [14, 14] });

  for (const [key, data] of byVenue) {
    const coord = venueCoords[key];
    if (!coord || !coord.lat) continue;

    const marker = L.marker([coord.lat, coord.lng], { icon: dot }).addTo(leafletMap);

    const bandsHtml = data.shows.flatMap(s => s.bands).map(b => {
      const name = typeof b === 'string' ? b : b.name;
      return `<div class="popup-band">${escHtml(name)}</div>`;
    }).join('');

    const firstShow = data.shows[0];
    const metaParts = [];
    if (firstShow.age)   metaParts.push(firstShow.age);
    if (firstShow.price) metaParts.push(firstShow.price);
    if (firstShow.doors) metaParts.push(`Doors ${firstShow.doors}`);

    const firstShowId = showId(firstShow);
    marker.bindPopup(`
      <a class="popup-venue popup-venue-link" data-show-id="${firstShowId}" data-show-date="${mapDate}" href="#${firstShowId}">${escHtml(data.venue.name)}</a>
      ${bandsHtml}
      ${metaParts.length ? `<div class="popup-meta">${metaParts.join(' · ')}</div>` : ''}
    `);
    marker.on('mouseover', () => marker.openPopup());
  }
}

function renderMap() {
  document.getElementById('main').style.display = 'none';
  const mapEl = document.getElementById('map-view');
  mapEl.classList.add('active');

  // Default map date to today (or earliest available)
  if (!mapDate) {
    const dates = mapAvailableDates();
    mapDate = dates.includes(todayISO()) ? todayISO() : (dates[0] || todayISO());
  }

  if (!leafletMap) {
    leafletMap = L.map('map-view', { zoomControl: true })
      .setView([37.785, -122.42], 12);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(leafletMap);
  } else {
    setTimeout(() => leafletMap.invalidateSize(), 50);
  }

  plotMapMarkers();
  updateMapDayNav();
}

function hideMap() {
  document.getElementById('map-view').classList.remove('active');
  document.getElementById('main').style.display = '';
}

// ── Venue view ───────────────────────────────────────────────────────────────

function renderVenueView() {
  hideWeekDaySelector();
  hideAllWeekSelector();
  document.body.classList.add('venue-view');
  const main = document.getElementById('main');
  const today = todayISO();

  // Next 7 days
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() + 7);
  const cutoff = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth()+1).padStart(2,'0')}-${String(cutoffDate.getDate()).padStart(2,'0')}`;

  // Group by venue, next 7 days only
  const venueMap = new Map();
  for (const show of allShows) {
    if (show.date < today || show.date > cutoff) continue;
    const key = show.venue.name.toLowerCase();
    if (!venueMap.has(key)) venueMap.set(key, { name: show.venue.name, shows: [] });
    venueMap.get(key).shows.push(show);
  }

  let venues = [...venueMap.values()];

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    venues = venues.filter(v =>
      v.name.toLowerCase().includes(q) ||
      v.shows.some(s => s.bands.some(b => (typeof b === 'string' ? b : b.name).toLowerCase().includes(q)))
    );
  }

  venues.sort((a, b) => a.name.localeCompare(b.name));

  if (!venues.length) {
    main.innerHTML = `<div class="empty-state"><h2>No shows in the next 7 days.</h2><p>Try "All Shows" to browse further ahead.</p></div>`;
    return;
  }

  // Which letters have venues
  const activeLetters = new Set(venues.map(v => v.name.replace(/^the\s+/i, '')[0].toUpperCase()));

  // Build venue cards
  const cardsHtml = venues.map(({ name, shows }) => {
    const anchor = name.replace(/^the\s+/i, '');
    const letter = anchor[0].toUpperCase();
    const slug   = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const ticketUrl = buyTicketsUrl(shows[0]);

    // Group shows by date
    const byDate = new Map();
    for (const show of shows) {
      if (!byDate.has(show.date)) byDate.set(show.date, []);
      byDate.get(show.date).push(show);
    }

    const datesHtml = [...byDate.entries()].map(([date, dateShows]) => {
      const [y, m, d] = date.split('-').map(Number);
      const dateLabel = new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const isToday   = date === today;

      const bandsHtml = dateShows.flatMap(s => s.bands).map(b => {
        const band = typeof b === 'string' ? { name: b } : b;
        return `<div class="band-item">
          <span class="band-name band-link" data-band="${escHtml(band.name)}">${escHtml(band.name)}</span>
          ${bandMusicBtns(band)}
        </div>`;
      }).join('');

      return `<div class="venue-date-group">
        <div class="venue-date-label">
          ${isToday ? '<span class="date-today-badge">Today</span>' : ''}
          ${escHtml(dateLabel)}
        </div>
        ${bandsHtml}
      </div>`;
    }).join('');

    return `<div class="venue-card" id="venue-${slug}" data-letter="${letter}">
      <div class="venue-card-header">
        <span class="venue-card-name">${escHtml(name)}</span>
        <a class="btn-buy venue-ticket-btn" href="${ticketUrl}" target="_blank" rel="noopener">${TICKET_ICON} Tickets</a>
      </div>
      <div class="venue-card-body">${datesHtml}</div>
    </div>`;
  }).join('');

  // Side A–Z strip
  const azHtml = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(l =>
    `<button class="venue-az-btn${activeLetters.has(l) ? '' : ' inactive'}" data-letter="${l}">${l}</button>`
  ).join('');

  main.innerHTML = `
    <div class="venue-cards">${cardsHtml}</div>
    <nav class="venue-az-side" aria-label="Jump to letter">${azHtml}</nav>
  `;

  main.querySelectorAll('.venue-az-btn:not(.inactive)').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = main.querySelector(`.venue-card[data-letter="${btn.dataset.letter}"]`);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function hideVenueView() {
  document.body.classList.remove('venue-view');
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Events ────────────────────────────────────────────────────────────────────

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentView = btn.dataset.view;
    if (currentView === 'map') {
      hideRadio();
      hideVenueView();
      renderMap();
    } else if (currentView === 'venue') {
      hideRadio();
      hideMap();
      renderVenueView();
    } else if (currentView === 'radio') {
      hideMap();
      hideVenueView();
      renderRadio();
    } else {
      hideRadio();
      hideMap();
      hideVenueView();
      render();
    }
  });
});

let searchTimer;
document.getElementById('search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchQuery = e.target.value.trim();
    if (currentView === 'venue') {
      renderVenueView();
    } else {
      if (searchQuery) {
        currentView = 'all';
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      }
      render();
    }
  }, 200);
});

// Map day navigation
document.getElementById('map-prev-day').addEventListener('click', () => {
  const dates = mapAvailableDates();
  const idx = dates.indexOf(mapDate);
  if (idx > 0) { mapDate = dates[idx - 1]; plotMapMarkers(); updateMapDayNav(); }
});
document.getElementById('map-next-day').addEventListener('click', () => {
  const dates = mapAvailableDates();
  const idx = dates.indexOf(mapDate);
  if (idx < dates.length - 1) { mapDate = dates[idx + 1]; plotMapMarkers(); updateMapDayNav(); }
});

// Map popup → list-view show navigation
document.addEventListener('click', e => {
  const link = e.target.closest('.popup-venue-link');
  if (!link) return;
  e.preventDefault();
  const id = link.dataset.showId;
  const showDate = link.dataset.showDate;

  // If it's today, switch to Today view; otherwise switch to All Shows and scroll to the date
  const targetView = showDate === todayISO() ? 'today' : 'all';
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === targetView);
  });
  currentView = targetView;
  hideMap();
  render();

  // Scroll to the show card after render
  requestAnimationFrame(() => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('highlight');
      setTimeout(() => el.classList.remove('highlight'), 5000);
    }
  });
});

// ── Artist panel ──────────────────────────────────────────────────────────────

function openArtistPanel(bandName) {
  const today = todayISO();

  // Collect all future shows for this band (case-insensitive)
  const bl = bandName.toLowerCase();
  const upcomingShows = allShows.filter(show =>
    show.date >= today &&
    show.bands.some(b => (typeof b === 'string' ? b : b.name).toLowerCase() === bl)
  );

  // Find the band's music links from first match that has them
  let spotifyUrl = null, youtubeUrl = null;
  for (const show of allShows) {
    for (const b of show.bands) {
      if (typeof b !== 'string' && b.name.toLowerCase() === bl) {
        if (b.spotifyUrl) spotifyUrl = b.spotifyUrl;
        if (b.youtubeUrl) youtubeUrl = b.youtubeUrl;
      }
    }
    if (spotifyUrl || youtubeUrl) break;
  }

  const linksHtml = [
    spotifyUrl ? `<a class="btn-spotify" href="${spotifyUrl}" target="_blank" rel="noopener">${SPOTIFY_ICON} Spotify</a>` : '',
    youtubeUrl ? `<a class="btn-youtube" href="${youtubeUrl}" target="_blank" rel="noopener">${YT_ICON} YouTube</a>` : '',
  ].filter(Boolean).join('');

  const showsHtml = upcomingShows.length
    ? upcomingShows.map(show => {
        const [y, m, d] = show.date.split('-').map(Number);
        const dateStr = new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        const isToday = show.date === today;
        return `<div class="panel-show-row">
          <span class="panel-show-date">${isToday ? '<span class="date-today-badge">Today</span> ' : ''}${escHtml(dateStr)}</span>
          <span class="panel-show-venue">${escHtml(show.venue.name)}</span>
        </div>`;
      }).join('')
    : `<p class="panel-no-shows">No upcoming Bay Area shows found.</p>`;

  document.getElementById('panel-content').innerHTML = `
    <div class="panel-band-name">${escHtml(bandName)}</div>
    ${linksHtml ? `<div class="panel-links">${linksHtml}</div>` : ''}

    <section class="panel-section">
      <h3 class="panel-section-title">Upcoming Shows</h3>
      ${showsHtml}
    </section>

    <section class="panel-section panel-subscribe-section">
      <h3 class="panel-section-title">Get Notified</h3>
      <p class="panel-subscribe-desc">Get an email when <strong>${escHtml(bandName)}</strong> has a new show in the Bay Area.</p>
      <div class="panel-subscribe-form">
        <input type="email" id="panel-email" class="panel-email-input" placeholder="your@email.com" autocomplete="email" />
        <button id="panel-subscribe-btn" class="btn-panel-subscribe">Notify Me</button>
      </div>
      <p id="panel-subscribe-status" class="panel-subscribe-status"></p>
    </section>
  `;

  // Subscribe button handler
  document.getElementById('panel-subscribe-btn').addEventListener('click', async () => {
    const email = (document.getElementById('panel-email').value || '').trim();
    const statusEl = document.getElementById('panel-subscribe-status');
    const btn = document.getElementById('panel-subscribe-btn');
    if (!email || !email.includes('@')) {
      statusEl.textContent = 'Please enter a valid email address.';
      statusEl.className = 'panel-subscribe-status error';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Sending…';
    statusEl.textContent = '';
    try {
      const res = await fetch(`${API_BASE}/api/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, band_name: bandName }),
      });
      const data = await res.json();
      if (data.status === 'confirmation_sent') {
        statusEl.textContent = '✓ Check your inbox to confirm your subscription.';
        statusEl.className = 'panel-subscribe-status success';
        btn.textContent = 'Email sent!';
      } else if (data.status === 'already_subscribed') {
        statusEl.textContent = '✓ You\'re already subscribed to alerts for this artist.';
        statusEl.className = 'panel-subscribe-status success';
        btn.textContent = 'Subscribed';
      } else {
        throw new Error(data.error || 'Unknown error');
      }
    } catch (err) {
      statusEl.textContent = `Could not subscribe: ${err.message}`;
      statusEl.className = 'panel-subscribe-status error';
      btn.disabled = false;
      btn.textContent = 'Notify Me';
    }
  });

  const panel = document.getElementById('artist-panel');
  const overlay = document.getElementById('panel-overlay');
  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';

  // Focus the panel for accessibility
  document.getElementById('panel-close').focus();
}

function closeArtistPanel() {
  const panel = document.getElementById('artist-panel');
  const overlay = document.getElementById('panel-overlay');
  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
  overlay.classList.remove('open');
  document.body.style.overflow = '';
}

// Close panel handlers
document.getElementById('panel-close').addEventListener('click', closeArtistPanel);
document.getElementById('panel-overlay').addEventListener('click', closeArtistPanel);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeArtistPanel(); });

// Open panel when any band name is clicked
document.addEventListener('click', e => {
  const link = e.target.closest('.band-link');
  if (!link) return;
  openArtistPanel(link.dataset.band);
});

// Show "subscribed" confirmation banner if redirected back from confirm link
(function checkSubscribedParam() {
  const params = new URLSearchParams(window.location.search);
  const band = params.get('subscribed');
  if (!band) return;
  const banner = document.createElement('div');
  banner.className = 'subscribed-banner';
  banner.innerHTML = `✓ You're subscribed to alerts for <strong>${escHtml(band)}</strong>! <button class="banner-close">✕</button>`;
  document.body.prepend(banner);
  banner.querySelector('.banner-close').addEventListener('click', () => banner.remove());
  window.history.replaceState({}, '', window.location.pathname);
})();

// ── Radio (jukebox) ──────────────────────────────────────────────────────────

let radioData = null;
let radioSource = 'spotify';       // 'spotify' | 'youtube'
let radioQueue = [];               // [{artist, shows, id, title}]
let radioIndex = 0;
let spotifyCtrl = null;
let ytPlayer = null;
let spotifyApiReady = null;        // Promise resolved when Spotify IFrame API loads
let ytApiReady = null;             // Promise resolved when YouTube IFrame API loads

window.onSpotifyIframeApiReady = (api) => {
  window._spotifyIframeApi = api;
  if (spotifyApiReady) spotifyApiReady._resolve(api);
};
window.onYouTubeIframeAPIReady = () => {
  if (ytApiReady) ytApiReady._resolve();
};

function waitForSpotifyApi() {
  if (window._spotifyIframeApi) return Promise.resolve(window._spotifyIframeApi);
  if (!spotifyApiReady) {
    spotifyApiReady = new Promise(resolve => { spotifyApiReady._resolve = resolve; });
  }
  return spotifyApiReady;
}
function waitForYtApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (!ytApiReady) {
    ytApiReady = new Promise(resolve => { ytApiReady._resolve = resolve; });
  }
  return ytApiReady;
}

async function loadRadioData() {
  if (radioData) return radioData;
  try {
    const res = await fetch('radio.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`radio.json ${res.status}`);
    radioData = await res.json();
    return radioData;
  } catch (e) {
    console.warn('radio.json not available yet:', e.message);
    return null;
  }
}

function buildRadioQueue(source, data) {
  const q = [];
  for (const a of (data.artists || [])) {
    if (source === 'spotify') {
      for (const t of (a.spotifyTracks || [])) {
        if (t.id) q.push({ artist: a.name, shows: a.shows || [], id: t.id, title: t.name });
      }
    } else if (source === 'youtube') {
      if (a.youtube && a.youtube.id) {
        q.push({ artist: a.name, shows: a.shows || [], id: a.youtube.id, title: a.youtube.title });
      }
    }
  }
  return q;
}

function formatShowsForRadio(shows) {
  if (!shows || !shows.length) return '';
  return shows.slice(0, 3).map(s => {
    const [y, m, d] = s.date.split('-').map(Number);
    const label = new Date(y, m - 1, d).toLocaleDateString('en-US',
      { weekday: 'short', month: 'short', day: 'numeric' });
    return `${label} · ${s.venue}`;
  }).join(' • ');
}

function renderRadioQueue() {
  const q = document.getElementById('radio-queue');
  if (!q) return;
  q.innerHTML = radioQueue.map((item, i) => `
    <div class="radio-row ${i === radioIndex ? 'active' : ''}" data-index="${i}">
      <div class="radio-row-num">${i + 1}</div>
      <div class="radio-row-body">
        <div class="radio-row-artist">${escHtml(item.artist)}</div>
        <div class="radio-row-title">${escHtml(item.title || '')}</div>
        <div class="radio-row-shows">${escHtml(formatShowsForRadio(item.shows))}</div>
      </div>
    </div>
  `).join('');
  q.querySelectorAll('.radio-row').forEach(row => {
    row.addEventListener('click', () => {
      radioIndex = Number(row.dataset.index);
      loadCurrentRadio(true);
    });
  });
  // Scroll active row into view
  const active = q.querySelector('.radio-row.active');
  if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderNowPlaying() {
  const el = document.getElementById('radio-now');
  if (!el) return;
  const cur = radioQueue[radioIndex];
  if (!cur) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="radio-now-artist band-link" data-band="${escHtml(cur.artist)}">${escHtml(cur.artist)}</div>
    <div class="radio-now-title">${escHtml(cur.title || '')}</div>
    <div class="radio-now-shows">${escHtml(formatShowsForRadio(cur.shows))}</div>
  `;
}

async function mountSpotifyPlayer() {
  const wrap = document.getElementById('radio-player-wrap');
  wrap.innerHTML = '<div id="spotify-embed"></div>';
  const api = await waitForSpotifyApi();
  const cur = radioQueue[radioIndex];
  if (!cur) return;
  api.createController(document.getElementById('spotify-embed'), {
    uri: `spotify:track:${cur.id}`,
    width: '100%',
    height: 152,
  }, ctrl => {
    spotifyCtrl = ctrl;
    let advancedFor = null;
    ctrl.addListener('playback_update', e => {
      const d = e.data || {};
      if (d.duration > 0 && d.position >= d.duration - 500 && advancedFor !== cur.id) {
        advancedFor = cur.id;
        advanceRadio();
      }
    });
    ctrl.play();
  });
}

async function mountYouTubePlayer() {
  const wrap = document.getElementById('radio-player-wrap');
  wrap.innerHTML = '<div id="yt-embed"></div>';
  await waitForYtApi();
  const cur = radioQueue[radioIndex];
  if (!cur) return;
  ytPlayer = new YT.Player('yt-embed', {
    height: '360',
    width: '100%',
    videoId: cur.id,
    playerVars: { autoplay: 1, playsinline: 1 },
    events: {
      onStateChange: e => {
        if (e.data === YT.PlayerState.ENDED) advanceRadio();
      },
    },
  });
}

function tearDownPlayers() {
  if (ytPlayer && ytPlayer.destroy) { try { ytPlayer.destroy(); } catch {} ytPlayer = null; }
  spotifyCtrl = null;
  const wrap = document.getElementById('radio-player-wrap');
  if (wrap) wrap.innerHTML = '';
}

function loadCurrentRadio(userInitiated = false) {
  const cur = radioQueue[radioIndex];
  if (!cur) return;
  if (radioSource === 'spotify' && spotifyCtrl) {
    spotifyCtrl.loadUri(`spotify:track:${cur.id}`);
    if (userInitiated) spotifyCtrl.play();
  } else if (radioSource === 'youtube' && ytPlayer && ytPlayer.loadVideoById) {
    ytPlayer.loadVideoById(cur.id);
  }
  renderNowPlaying();
  renderRadioQueue();
}

function advanceRadio() {
  radioIndex = (radioIndex + 1) % radioQueue.length;
  loadCurrentRadio();
}

function prevRadio() {
  radioIndex = (radioIndex - 1 + radioQueue.length) % radioQueue.length;
  loadCurrentRadio(true);
}

async function switchRadioSource(source) {
  radioSource = source;
  document.querySelectorAll('.radio-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.src === source));
  radioQueue = buildRadioQueue(source, radioData);
  radioIndex = 0;
  tearDownPlayers();
  if (!radioQueue.length) {
    document.getElementById('radio-player-wrap').innerHTML =
      `<p class="radio-empty">No ${source} tracks available yet — check back after the next daily sync.</p>`;
    document.getElementById('radio-queue').innerHTML = '';
    document.getElementById('radio-now').innerHTML = '';
    return;
  }
  renderNowPlaying();
  renderRadioQueue();
  if (source === 'spotify') await mountSpotifyPlayer();
  else await mountYouTubePlayer();
}

async function renderRadio() {
  document.getElementById('main').hidden = true;
  document.getElementById('radio-view').hidden = false;
  document.body.classList.add('radio-view-active');
  hideWeekDaySelector?.();
  hideAllWeekSelector?.();

  const data = await loadRadioData();
  if (!data) {
    document.getElementById('radio-sub').textContent =
      'Radio not available yet — waiting for first daily sync.';
    return;
  }
  const genDate = new Date(data.generated).toLocaleDateString('en-US',
    { month: 'short', day: 'numeric' });
  document.getElementById('radio-sub').innerHTML =
    `Top <strong>${data.artists.length}</strong> artists playing this week · updated ${genDate}`;
  await switchRadioSource(radioSource);
}

function hideRadio() {
  document.getElementById('main').hidden = false;
  document.getElementById('radio-view').hidden = true;
  document.body.classList.remove('radio-view-active');
  tearDownPlayers();
}

// Radio event wiring
document.querySelectorAll('.radio-tab').forEach(tab => {
  tab.addEventListener('click', () => switchRadioSource(tab.dataset.src));
});
document.getElementById('radio-prev').addEventListener('click', prevRadio);
document.getElementById('radio-next').addEventListener('click', advanceRadio);

loadData();
