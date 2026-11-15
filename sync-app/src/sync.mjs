// v2.1: Retro Lyrics Display - auto-sync with Spotify, word by word
// Run with:  npm start
//
// Needs:
//  - tokens.json (made by npm run login)
//  - the Uno running lcd_serial_listener
//  - the Arduino Serial Monitor CLOSED (only one program can use COM3)
//
// How it works:
//  1. Every 2 seconds, ask Spotify: what song, and how many ms into it?
//     We add half the network round trip, because the answer is a bit old when it arrives.
//  2. When the song changes, fetch its timed lyrics from LRCLIB.
//     - If the song has real word-by-word timing (LRCLIB "lyricsfile"), use it.
//     - Otherwise spread each line's time across its words (longer words get more time).
//  3. Every 0.05 seconds, estimate where the song is now and show the words
//     sung so far on the Uno as "top row|bottom row".
//  4. Arrow keys nudge the timing live: LEFT = lyrics earlier, RIGHT = lyrics later.
//     Save your favorite number in .env as LEAD_MS=...

import { readFile, writeFile } from 'node:fs/promises';
import readline from 'node:readline';
import { SerialPort } from 'serialport';

// Optional helper for real word timing (install once with: npm install yaml)
let parseYaml = null;
try {
  ({ parse: parseYaml } = await import('yaml'));
} catch {
  console.log('(Tip: run "npm install yaml" to use real word-by-word timing when a song has it.)');
}

// ---------- Settings (tweak these) ----------
const PORT_PATH = 'COM3';  // your Uno's port
const POLL_MS = 2000;      // how often we ask Spotify where the song is
const TICK_MS = 50;        // how often we update the LCD (50 = smooth word by word)
const envLead = Number(process.env.LEAD_MS);
let leadMs = Number.isFinite(envLead) ? envLead : 250; // bigger = lyrics show earlier. Nudge live with the arrow keys.
const MAX_LINE_MS = 6000;  // longest time one line's words get spread across
const WORD_SPREAD = 0.85;  // estimated words finish at 85% of the line (singers finish before the next line)
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const USER_AGENT = 'retro-lyrics-display/0.2 (personal Arduino project)';

// ---------- State (the program's "memory") ----------
let tokens;
let port;
let track = null;          // { id, name, artist, album, durationMs }
let lyrics = null;         // [{ ms, text, lineMs, words: [{ w, ms }] }]
let lyricsStatus = 'idle'; // 'loading' | 'synced' | 'none'
let isPlaying = false;
let progressAtPoll = 0;    // Spotify's progress_ms at our last check (+ half the network trip)
let pollTime = 0;          // when that answer arrived (Date.now())
let pauseUntil = 0;        // if Spotify says "slow down", wait until this time
let lastSent = '';
let shownKey = '';         // which song + line is on the screen
let shownCount = 0;        // how many of its words are showing

// ---------- LCD helpers ----------

// The LCD only knows basic English characters, so simplify the text
function cleanText(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // é -> e
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"') // curly quotes -> straight
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

  const sentAt = Date.now(); // when we asked Spotify
  const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const gotAt = Date.now();  // when Spotify answered

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

  // Spotify's answer is already a bit old when it arrives:
  // add half the round trip (the time it took to travel back to us)
  const halfTrip = (gotAt - sentAt) / 2;
  isPlaying = data.is_playing;
  progressAtPoll = (data.progress_ms ?? 0) + halfTrip;
  pollTime = gotAt;

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

// Real word timing: LRCLIB's new "lyricsfile" (YAML) has a start time for every word.
// Returns lines like { ms, text, words: [{ w, ms }] }, or null if there's no word timing.
function parseLyricsfile(yamlText) {
  const doc = parseYaml(yamlText);
  const lines = (doc?.lines ?? [])
    .filter((l) => Number.isFinite(l.start_ms))
    .map((l) => ({
      ms: l.start_ms,
      text: l.text ?? '',
      words: (l.words ?? [])
        .map((w) => {
          const raw = String(w.text ?? '');
          // keep the spaces between words (a word split into syllables has no space)
          const text = (/^\s/.test(raw) ? ' ' : '') + cleanText(raw) + (/\s$/.test(raw) ? ' ' : '');
          return { w: text, ms: w.start_ms };
        })
        .filter((w) => w.w.trim() && Number.isFinite(w.ms)),
    }));
  return lines.some((l) => l.words.length) ? lines.sort((a, b) => a.ms - b.ms) : null;
}

// Estimated word timing: spread a line's time across its words.
// Longer words get more time.
function estimateWords(text, startMs, lineMs) {
  const words = cleanText(String(text).replace(/<[^>]*>/g, ' ')).split(/\s+/).filter(Boolean);
  const totalChars = words.reduce((sum, w) => sum + w.length + 1, 0);
  let charsBefore = 0;
  return words.map((w) => {
    const ms = startMs + Math.round(lineMs * WORD_SPREAD * (charsBefore / totalChars));
    charsBefore += w.length + 1;
    return { w: w + ' ', ms };
  });
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

    // 2nd try: search, and prefer the same song length
    // (a radio edit or live version has different timing)
    if (!found?.syncedLyrics) {
      const q = new URLSearchParams({ track_name: t.name, artist_name: t.artist });
      res = await fetch(`https://lrclib.net/api/search?${q}`, { headers });
      const results = res.ok ? await res.json() : [];
      const sameLength = (r) => Math.abs((r.duration ?? 0) - t.durationMs / 1000) <= 2;
      found =
        results.find((r) => sameLength(r) && r.hasWordSync) ??
        results.find((r) => sameLength(r) && r.syncedLyrics) ??
        results.find((r) => r.syncedLyrics) ??
        null;
    }

    if (track?.id !== t.id) return; // the song changed while we were looking

    if (!found?.syncedLyrics) {
      lyricsStatus = 'none';
      console.log('No synced lyrics found for this song.');
      return;
    }

    // Real word times if this song has them, otherwise line times + our estimate
    let parsed = null;
    if (parseYaml && found.hasWordSync && found.lyricsfile) {
      try { parsed = parseLyricsfile(found.lyricsfile); } catch { parsed = null; }
    }
    const realWords = Boolean(parsed);
    if (!parsed) parsed = parseLrc(found.syncedLyrics);

    lyrics = parsed.map((line, i) => {
      const nextMs = parsed[i + 1]?.ms ?? line.ms + MAX_LINE_MS;
      const lineMs = Math.max(Math.min(nextMs - line.ms, MAX_LINE_MS), 500);
      return {
        ...line,
        lineMs,
        words: line.words?.length ? line.words : estimateWords(line.text, line.ms, lineMs),
      };
    });
    lyricsStatus = 'synced';
    console.log(`Loaded ${lyrics.length} lines (${realWords ? 'REAL word timing' : 'estimated word timing'}).`);
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
  const now = currentProgress() + leadMs;
  let idx = -1;
  for (let i = 0; i < lyrics.length; i++) {
    if (lyrics[i].ms <= now) idx = i;
    else break;
  }

  if (idx === -1) return send(track.name, track.artist); // before the first line: show the title
  const line = lyrics[idx];
  if (!line.words.length) return send('', '   ~ music ~'); // instrumental gap

  // How many words have been sung so far? (always at least the first one)
  let count = Math.max(line.words.filter((x) => x.ms <= now).length, 1);
  // Never take a word back (tiny clock wobbles between Spotify checks)
  const key = `${track.id}:${idx}`;
  if (key === shownKey) count = Math.max(count, shownCount);
  shownKey = key;
  shownCount = count;

  // Show the newest page of the words sung so far
  const sung = line.words.slice(0, count).map((x) => x.w).join('');
  const pages = toPages(sung);
  const [top, bottom] = pages[pages.length - 1];
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

  // Arrow keys nudge the timing while a song plays
  //   LEFT  = lyrics show EARLIER (use when they're late)
  //   RIGHT = lyrics show LATER   (use when they're early)
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('keypress', (str, key) => {
    if (key?.ctrl && key.name === 'c') return process.emit('SIGINT'); // keep Ctrl + C working
    if (key?.name === 'left') leadMs += 50;
    else if (key?.name === 'right') leadMs -= 50;
    else return;
    console.log(`Timing: LEAD_MS=${leadMs}  (save this number in .env when it feels right)`);
  });

  console.log(`Running. Timing: LEAD_MS=${leadMs}. Arrow keys: LEFT = earlier, RIGHT = later.`);
  console.log('Play something in Spotify. Press Ctrl + C to stop.');
}

main();
