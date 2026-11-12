// v2: Retro Lyrics Display - auto-sync with Spotify
// Run with:  npm start
//
// Needs:
//  - tokens.json (made by npm run login)
//  - the Uno running 06-lcd-listener
//  - the Arduino Serial Monitor CLOSED (only one program can use COM3)
//
// How it works:
//  1. Every 2 seconds, ask Spotify: what song, and how many ms into it?
//  2. When the song changes, fetch its timed lyrics from LRCLIB.
//  3. Every 0.1 seconds, estimate where the song is now and send the
//     matching lyric line to the Uno as "top row|bottom row".

import { readFile, writeFile } from 'node:fs/promises';
import { SerialPort } from 'serialport';

// ---------- Settings (tweak these) ----------
const PORT_PATH = 'COM3';  // your Uno's port
const POLL_MS = 2000;      // how often we ask Spotify where the song is
const TICK_MS = 100;       // how often we check if the lyric line should change
const LEAD_MS = 250;       // show lines slightly early to cover delays. Lyrics late? raise it. Early? lower it.
const MAX_LINE_MS = 6000;  // long lines flip pages within this much time (covers long gaps before the next line)
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const USER_AGENT = 'retro-lyrics-display/0.1 (personal Arduino project)';

// ---------- State (the program's "memory") ----------
let tokens;
let port;
let track = null;          // { id, name, artist, album, durationMs }
let lyrics = null;         // [{ ms, text }]
let lyricsStatus = 'idle'; // 'loading' | 'synced' | 'none'
let isPlaying = false;
let progressAtPoll = 0;    // Spotify's progress_ms at our last check
let pollTime = 0;          // when we did that check (Date.now())
let pauseUntil = 0;        // if Spotify says "slow down", wait until this time
let lastSent = '';

// ---------- LCD helpers ----------

// The LCD only knows basic English characters, so simplify the text
function cleanText(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // é -> e
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')       // curly quotes -> straight
    .replace(/\|/g, '/')                               // | is our divider, so never send it inside text
    .replace(/[^\x20-\x7E]/g, '')                      // drop anything the LCD can't show
    .trim();
}

// Word-wrap text into 16-character rows, then group the rows into "pages"
// of 2 rows each (one page = one full LCD screen). Nothing gets dropped.
function toPages(text) {
  const words = cleanText(text).split(/\s+/).filter(Boolean);
  const rows = [];
  let row = '';
  for (let w of words) {
    while (w.length > 16) {               // giant word: chop it into 16-character pieces
      if (row) { rows.push(row); row = ''; }
      rows.push(w.slice(0, 16));
      w = w.slice(16);
    }
    if (!w) continue;
    const candidate = row ? `${row} ${w}` : w;
    if (candidate.length <= 16) {
      row = candidate;                    // the word fits on this row
    } else {
      rows.push(row);                     // row is full: start a new one
      row = w;
    }
  }
  if (row) rows.push(row);

  const pages = [];
  for (let i = 0; i < rows.length; i += 2) pages.push([rows[i], rows[i + 1] ?? '']);
  return pages.length ? pages : [['', '']];
}

// A long line has several pages. Split the line's time between them,
// giving pages with more text more time (like a slideshow).
function pickPage(pages, msIntoLine, lineMs) {
  if (pages.length === 1) return pages[0];
  const sizes = pages.map(([top, bottom]) => (top.length + bottom.length) || 1);
  const total = sizes.reduce((a, b) => a + b, 0);
  const progress = Math.min(Math.max(msIntoLine / lineMs, 0), 0.999); // 0 = line just started, 1 = next line
  let share = 0;
  for (let i = 0; i < pages.length; i++) {
    share += sizes[i] / total;
    if (progress < share) return pages[i];
  }
  return pages[pages.length - 1];
}

// Send "top|bottom" to the Uno, but only if it changed
function send(top, bottom = '') {
  const msg = `${cleanText(top).slice(0, 16)}|${cleanText(bottom).slice(0, 16)}`;
  if (msg === lastSent) return;
  lastSent = msg;
  port.write(msg + '\n');
  console.log('LCD >', msg.replace('|', '  /  '));
}

// ---------- Spotify ----------

async function loadTokens() {
  tokens = JSON.parse(await readFile('tokens.json', 'utf8'));
}

// Access tokens last 1 hour. Use the refresh token to get a new one.
async function refreshIfNeeded() {
  if (Date.now() < tokens.expires_at - 60_000) return;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: CLIENT_ID,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}). Run npm run login again.`);
  }
  tokens = {
    ...tokens,
    ...data,
    refresh_token: data.refresh_token ?? tokens.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  await writeFile('tokens.json', JSON.stringify(tokens, null, 2));
  console.log('(Refreshed Spotify access token)');
}

async function pollSpotify() {
  if (Date.now() < pauseUntil) return;
  await refreshIfNeeded();

  const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (res.status === 429) {                       // too many requests
    const wait = Number(res.headers.get('retry-after') ?? 10);
    pauseUntil = Date.now() + wait * 1000;
    console.log(`Spotify says slow down. Waiting ${wait}s.`);
    return;
  }
  if (res.status === 204) {                       // nothing playing
    isPlaying = false;
    return;
  }
  if (!res.ok) {
    console.error('Spotify error:', res.status, await res.text());
    return;
  }

  const data = await res.json();
  if (!data.item || data.currently_playing_type !== 'track') {
    isPlaying = false;                            // ad, podcast, etc.
    return;
  }

  isPlaying = data.is_playing;
  progressAtPoll = data.progress_ms ?? 0;
  pollTime = Date.now();

  const item = data.item;
  if (!track || track.id !== item.id) {
    track = {
      id: item.id,
      name: item.name,
      artist: item.artists?.[0]?.name ?? '',
      album: item.album?.name ?? '',
      durationMs: item.duration_ms,
    };
    console.log(`\nNew song: ${track.name} - ${track.artist}`);
    loadLyrics(track); // runs in the background while we keep polling
  }
}

// ---------- Lyrics (LRCLIB) ----------

// LRC format: "[01:23.45] some words"  ->  { ms: 83450, text: "some words" }
function parseLrc(lrc) {
  const lines = [];
  for (const raw of lrc.split('\n')) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (tags.length === 0) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const [, min, sec] of tags) {
      lines.push({ ms: Math.round((Number(min) * 60 + Number(sec)) * 1000), text });
    }
  }
  return lines.sort((a, b) => a.ms - b.ms);
}

async function loadLyrics(t) {
  lyrics = null;
  lyricsStatus = 'loading';
  const headers = { 'User-Agent': USER_AGENT };
  try {
    // 1st try: exact match on title + artist + album + length
    const exact = new URLSearchParams({
      track_name: t.name,
      artist_name: t.artist,
      album_name: t.album,
      duration: String(Math.round(t.durationMs / 1000)),
    });
    let res = await fetch(`https://lrclib.net/api/get?${exact}`, { headers });
    let found = res.ok ? await res.json() : null;

    // 2nd try: search by title + artist
    if (!found?.syncedLyrics) {
      const q = new URLSearchParams({ track_name: t.name, artist_name: t.artist });
      res = await fetch(`https://lrclib.net/api/search?${q}`, { headers });
      const results = res.ok ? await res.json() : [];
      found = results.find((r) => r.syncedLyrics) ?? null;
    }

    if (track?.id !== t.id) return; // the song changed while we were looking

    if (!found?.syncedLyrics) {
      lyricsStatus = 'none';
      console.log('No synced lyrics found for this song.');
      return;
    }
    // Pre-split every line into LCD pages, and work out how long each line lasts
    const parsed = parseLrc(found.syncedLyrics);
    lyrics = parsed.map((line, i) => {
      const nextMs = parsed[i + 1]?.ms ?? line.ms + MAX_LINE_MS;
      return {
        ...line,
        pages: toPages(line.text),
        lineMs: Math.max(Math.min(nextMs - line.ms, MAX_LINE_MS), 500),
      };
    });
    lyricsStatus = 'synced';
    console.log(`Loaded ${lyrics.length} timed lines.`);
  } catch (err) {
    if (track?.id === t.id) lyricsStatus = 'none';
    console.error('Lyrics lookup failed:', err.message);
  }
}

// ---------- The sync loop ----------

// Spotify told us the position a moment ago; add the time since then
function currentProgress() {
  return isPlaying ? progressAtPoll + (Date.now() - pollTime) : progressAtPoll;
}

function updateDisplay() {
  if (!track) return send('Retro Lyrics', 'Play a song...');
  if (!isPlaying) return send('- Paused -', track.name);
  if (lyricsStatus === 'loading') return send(track.name, track.artist);
  if (lyricsStatus === 'none' || !lyrics?.length) return send(track.name, 'No synced lyrics');

  // Find the last line whose start time has passed
  const now = currentProgress() + LEAD_MS;
  let idx = -1;
  for (let i = 0; i < lyrics.length; i++) {
    if (lyrics[i].ms <= now) idx = i;
    else break;
  }

  if (idx === -1) return send(track.name, track.artist); // before the first line: show the title
  const line = lyrics[idx];
  if (!line.text) return send('', '   ~ music ~');        // instrumental gap
  const [top, bottom] = pickPage(line.pages, now - line.ms, line.lineMs);
  send(top, bottom);
}

// ---------- Start ----------

async function main() {
  if (!CLIENT_ID) {
    console.error('Missing SPOTIFY_CLIENT_ID. Run with:  npm start');
    process.exit(1);
  }
  try {
    await loadTokens();
  } catch {
    console.error('No tokens.json yet. Run npm run login first.');
    process.exit(1);
  }

  port = new SerialPort({ path: PORT_PATH, baudRate: 9600 });
  try {
    await new Promise((resolve, reject) => {
      port.once('open', resolve);
      port.once('error', reject);
    });
  } catch (err) {
    console.error('Could not open', PORT_PATH + ':', err.message);
    if (err.message.includes('Access denied')) console.error('-> Close the Arduino Serial Monitor and try again.');
    process.exit(1);
  }
  port.on('error', (err) => console.error('Serial error:', err.message));

  console.log(`Connected to the Uno on ${PORT_PATH}. Waiting for it to boot...`);
  await new Promise((r) => setTimeout(r, 2000)); // opening the port restarts the Uno
  send('Retro Lyrics', 'Connecting...');

  // Ask Spotify every POLL_MS
  const poll = async () => {
    try {
      await pollSpotify();
    } catch (err) {
      console.error(err.message);
    }
    setTimeout(poll, POLL_MS);
  };
  poll();

  // Update the LCD every TICK_MS
  setInterval(updateDisplay, TICK_MS);

  // Ctrl + C: say bye, then let go of the port
  process.on('SIGINT', () => {
    port.write('Retro Lyrics|See you soon!\n', () => port.drain(() => process.exit(0)));
  });

  console.log('Running. Play something in Spotify. Press Ctrl + C to stop.');
}

main();
