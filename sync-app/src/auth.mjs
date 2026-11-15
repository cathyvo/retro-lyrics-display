// v2 Step 5: log in to Spotify and check what's playing.
// Run with:  npm run login
//
// What happens:
// 1. Your browser opens Spotify's login/permission page.
// 2. You click "Agree". Spotify sends a one-time code back to this program
//    at http://127.0.0.1:8888/callback (your own PC).
// 3. The program trades that code for an access token (a 1-hour "key card")
//    plus a refresh token (a pass to get new key cards), and saves them in tokens.json.
// 4. It asks Spotify what's playing right now, as a test.

import http from 'node:http';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const REDIRECT_URI = 'http://127.0.0.1:8888/callback'; // must match the Spotify dashboard EXACTLY
const SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state'; // modify = pause/play from the remote's sleep button

if (!CLIENT_ID) {
  console.error('No Client ID found. Check that .env has a line like: SPOTIFY_CLIENT_ID=abc123');
  process.exit(1);
}

// PKCE: a "secret handshake" so only THIS program can trade the one-time code.
const verifier = crypto.randomBytes(64).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const state = crypto.randomBytes(16).toString('hex'); // guards against fake callbacks

const authUrl = new URL('https://accounts.spotify.com/authorize');
authUrl.search = new URLSearchParams({
  client_id: CLIENT_ID,
  response_type: 'code',
  redirect_uri: REDIRECT_URI,
  scope: SCOPES,
  code_challenge_method: 'S256',
  code_challenge: challenge,
  state,
}).toString();

// A tiny local web server that waits for Spotify to send you back
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:8888');
  if (url.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }

  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');

  if (error || !code || url.searchParams.get('state') !== state) {
    res.end('Login failed. Check PowerShell for details.');
    console.error('Login failed:', error || 'missing code or state mismatch');
    server.close();
    return;
  }

  try {
    // Trade the one-time code for tokens
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(`${tokenRes.status} ${JSON.stringify(tokens)}`);

    tokens.expires_at = Date.now() + tokens.expires_in * 1000;
    await writeFile('tokens.json', JSON.stringify(tokens, null, 2));
    res.end('Logged in! You can close this tab and go back to PowerShell.');
    console.log('Logged in. Tokens saved to tokens.json (keep this file private).');

    await showNowPlaying(tokens.access_token);
  } catch (err) {
    res.end('Something went wrong. Check PowerShell.');
    console.error('Token exchange failed:', err.message);
  } finally {
    server.close();
  }
});

async function showNowPlaying(accessToken) {
  const r = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (r.status === 204) {
    console.log('Nothing is playing right now. Start a song in Spotify and run this again.');
    return;
  }
  if (r.status === 403) {
    console.error('403 Forbidden: add your Spotify email under Dashboard > your app > Settings > User Management.');
    return;
  }
  if (!r.ok) {
    console.error('Spotify error:', r.status, await r.text());
    return;
  }

  const data = await r.json();
  if (!data.item) {
    console.log('Something is playing, but it is not a song (an ad or a podcast?).');
    return;
  }

  const seconds = Math.floor((data.progress_ms ?? 0) / 1000);
  console.log('\nNow playing:');
  console.log('  Song:  ', data.item.name);
  console.log('  Artist:', data.item.artists.map((a) => a.name).join(', '));
  console.log('  Album: ', data.item.album.name);
  console.log(`  At:     ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} (${data.progress_ms} ms)`);
}

server.listen(8888, '127.0.0.1', () => {
  console.log('Opening Spotify login in your browser...');
  console.log('If it does not open, Ctrl+click (or copy) this link:\n' + authUrl.toString() + '\n');
  exec(`start "" "${authUrl.toString()}"`); // Windows: open the default browser
});
