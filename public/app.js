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
const YT_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M23.495 6.205a3.007 3.007 0 0 0-2.088-2.088c-1.87-.501-9.396-.501-9.396-.501s-7.507-.01-9.396.501A3.007 3.007 0 0 0 .527 6.205a31.247 31.247 0 0 0-.522 5.805 31.247 31.247 0 0 0 .522 5.783 3.007 3.007 0 0 0 2.088 2.088c1.868.502 9.396.502 9.396.502s7.506 0 9.396-.502a3.007 3.007 0 0 0 2.088-2.088 31.247 31.247 0 0 0 .5-5.783 31.247 31.247 0 0 0-.5-5.805zM9.609 15.601V8.408l6.264 3.602z"/></svg>`;

let allShows = [];
let currentView = 'today';
let searchQuery = '';

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadData() {
  try {
    const res = await fetch('data.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    allShows = payload.shows || [];
    const updated = new Date(payload.updated);
    document.getElementById('updated-note').textContent =
      `Updated ${updated.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;
    render();
  } catch (e) {
    document.getElementById('main').innerHTML = `
      <div class="empty-state">
        <h2>Could not load shows</h2>
        <p>${e.message}</p>
      </div>`;
  }
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

  return `
    <div class="show-card">
      <div class="bands-list">${bandsHtml}</div>
      <div class="card-meta">
        ${venueHtml}
        ${pills.join('')}
        ${renderSymbols(show.symbols)}
      </div>
    </div>`;
}

function render() {
  const shows = filterShows(allShows);
  const main = document.getElementById('main');

  if (!shows.length) {
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

  // Scroll to today if in all-shows view
  if (currentView === 'all') {
    const todayEl = document.getElementById(`date-${todayISO()}`);
    if (todayEl) todayEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
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
    render();
  });
});

let searchTimer;
document.getElementById('search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchQuery = e.target.value.trim();
    if (searchQuery) {
      currentView = 'all';
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    }
    render();
  }, 200);
});

loadData();
