'use strict';

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
        <span class="band-name">${escHtml(band.name)}</span>
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
  const main = document.getElementById('main');
  const today = todayISO();

  // Group all future shows by venue name (case-insensitive key)
  const venueMap = new Map();
  for (const show of allShows) {
    if (show.date < today) continue;
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
    main.innerHTML = `<div class="empty-state"><h2>No venues found.</h2></div>`;
    return;
  }

  // Build alphabet index — only letters that have venues
  const letters = [...new Set(venues.map(v => v.name[0].toUpperCase()))];
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const alphaHtml = `<div class="venue-alpha-index">${
    alphabet.map(l =>
      `<button class="venue-alpha-btn" data-letter="${l}" ${letters.includes(l) ? '' : 'disabled'}>${l}</button>`
    ).join('')
  }</div>`;

  const rowsHtml = venues.map(venueData => {
    const { name, shows } = venueData;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const letter = name[0].toUpperCase();

    // Group shows by date
    const byDate = new Map();
    for (const show of shows) {
      if (!byDate.has(show.date)) byDate.set(show.date, []);
      byDate.get(show.date).push(show);
    }

    const ticketUrl = buyTicketsUrl(shows[0]);

    const datesHtml = [...byDate.entries()].map(([date, dateShows]) => {
      const [y, m, d] = date.split('-').map(Number);
      const dateObj = new Date(y, m - 1, d);
      const dateLabel = dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const isToday = date === today;

      const bandsHtml = dateShows.flatMap(s => s.bands).map(b => {
        const band = typeof b === 'string' ? { name: b } : b;
        return `<div class="band-item">
          <span class="band-name">${escHtml(band.name)}</span>
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

    return `<div class="venue-row" id="venue-${slug}" data-letter="${letter}">
      <div class="venue-row-header">
        <span class="venue-row-name">${escHtml(name)}</span>
        <span class="venue-row-count">${shows.length} show${shows.length !== 1 ? 's' : ''}</span>
        <a class="btn-buy" href="${ticketUrl}" target="_blank" rel="noopener">${TICKET_ICON} Tickets</a>
        <span class="venue-row-arrow">▾</span>
      </div>
      <div class="venue-row-body">${datesHtml}</div>
    </div>`;
  }).join('');

  main.innerHTML = alphaHtml + `<div class="venue-list">${rowsHtml}</div>`;

  // Accordion toggle — ignore clicks on the ticket button
  main.querySelectorAll('.venue-row-header').forEach(header => {
    header.addEventListener('click', e => {
      if (e.target.closest('.btn-buy')) return;
      header.closest('.venue-row').classList.toggle('open');
    });
  });

  // Alphabet jump
  main.querySelectorAll('.venue-alpha-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = main.querySelector(`.venue-row[data-letter="${btn.dataset.letter}"]`);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
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
      renderMap();
    } else if (currentView === 'venue') {
      hideMap();
      renderVenueView();
    } else {
      hideMap();
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

loadData();
