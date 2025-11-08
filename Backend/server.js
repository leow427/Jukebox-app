import express from 'express';
import https from 'https';
import fs from 'fs';
import dotenv from 'dotenv';
import crypto from 'crypto';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
const queueList = [];

dotenv.config();

const app = express();
app.use(express.json()); 


app.get('/health', (req, res) => {
    res.json({ ok: true})
})


// needed for __dirname with ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// serve the frontend folder
app.use(express.static(path.resolve(__dirname, '../frontend')));


//token store
const TOKENS_FILE = './tokens.json'

let tokens = {
    accessToken: null,
    refreshToken: null,
    expiresIn: 0 //in ms
};

function loadTokens() {
    try {
        const raw = fs.readFileSync(TOKENS_FILE, 'utf8');
        const t =JSON.parse(raw);
        tokens = t;
        console.log('[tokens] loaded');
    } catch (_) {
        console.log('[tokens] none on disk yet');
    }
}

function saveTokens() {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}
loadTokens();


let pkce = {verifier: null};

//.env variables
const CLIENT_ID = (process.env.SPOTIFY_CLIENT_ID || '').trim();
const REDIRECT_URI = (process.env.REDIRECT_URI || '').trim();


if (!CLIENT_ID || !/^https:\/\/.+\/callback$/.test(REDIRECT_URI)) {
  throw new Error('REDIRECT_URI must be https and end with /callback (e.g., https://localhost:8888/callback).');
}



// reads https certs to prove encryption
const httpsOpts = {
  key: fs.readFileSync('./127.0.0.1-key.pem'),
  cert: fs.readFileSync('./127.0.0.1.pem')
};
https.createServer(httpsOpts, app).listen(process.env.PORT || 8888, () => {
  console.log('HTTPS on https://127.0.0.1:' + (process.env.PORT || 8888));
});

//replaces non-friendly URI characters to stuff like - and _
function b64url(buf) {
    return buf.toString('base64')
    .replace(/\+/g,'-')
    .replace(/\//g, '_')
    .replace(/=+$/,'');
}



app.get('/login',(req, res) => {
    pkce.verifier = b64url(crypto.randomBytes(64));

    const challenge = b64url(
    crypto.createHash('sha256').update(pkce.verifier).digest()
  );
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        scope: [
            'user-read-playback-state',
            'user-modify-playback-state',
            'user-read-currently-playing',
            'playlist-read-private',
            'playlist-read-collaborative'
        ].join(' ')
    });

    res.redirect('https://accounts.spotify.com/authorize?' + params.toString());
});


app.get('/callback', async (req, res) => {
  console.log('[callback] query:', req.query);
 
  const code = req.query.code;
    
  try {
        //spotify token endpoint
        const tokenUrl = "https://accounts.spotify.com/api/token";

        const body = new URLSearchParams({
            client_id: CLIENT_ID,
            grant_type: 'authorization_code',
            code, 
            redirect_uri: REDIRECT_URI,
            code_verifier: pkce.verifier,

        });

        //payload to get token
        const payload = await fetch(tokenUrl, {
            method: 'POST',
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
            body
        });

        const data = await payload.json();
        
        //error handling
        if (!payload.ok) {
            console.error('Token exchange failed:', data);
            return res.status(500).json(data);
        }
    

        //IMPORTANT - tokens
        tokens.accessToken = data.access_token;
        tokens.refreshToken = data.refresh_token || tokens.refreshToken;
        tokens.expiresIn = Date.now() + (data.expires_in * 1000);
        saveTokens();

        

        console.log('Access Token:', data.access_token);
        console.log('Refresh Token:', data.refresh_token);

        return res.redirect('https://127.0.0.1:8888');
        
        

    } catch (error) {
            console.error('Token exchange error:', error);
            return res.status(500).send('Token exhange error');
        }
});

async function refreshAccessToken() {
    const body = new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken
    });

    const resp = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body
    });
    const j = await resp.json();
    if (!resp.ok) {
        console.error('[tokens] refresh failed', j);
    }
    tokens.accessToken = j.access_token;

    if (j.refresh_token) tokens.refreshToken = j.refresh_token;
    tokens.expiresIn = Date.now() + (j.expires_in * 1000);
    saveTokens();
    console.log('[tokens] refreshed, new expiry', new Date(tokens.expiresIn).toISOString());
}

// checks if refresh is needed before making API requests
function tokenValid() {
    return tokens.accessToken && Date.now() < tokens.expiresIn;
}

//this lets you stay logged in
async function spotifyFetch(url, opts = {}, retried = false) {
    if (Date.now() > tokens.expiresIn - 60_000) {
        try { await refreshAccessToken(); } catch (_) {}
    }

    const resp = await fetch(url, {
        ...opts,
        headers: {
            ...(opts.headers || {}),
            Authorization: `Bearer ${tokens.accessToken}`
        }
    });

    //handle expired/limited
    if (resp.status == 401 && !retried) {
        await refreshAccessToken();
        return spotifyFetch(url, opts, true);
    }

    if (resp.status == 429 && !retried) {
        const retryAfter = parseInt(resp.headers.get('retry-after') || '1', 10);
        await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
        return spotifyFetch(url, opts, true);
    }
    return resp;
}

 
function parseSpotifyEntity(input) {
    const str = String(input || '').trim();
    if (!str) return null;

    const uriMatch = str.match(/^spotify:(track):([0-9A-Za-z]{22})$/i);
    if (uriMatch) return { type: 'track', id: uriMatch[2] };

    const playlistUri = str.match(/^spotify:(?:user:[^:]+:)?playlist:([0-9A-Za-z]{22})$/i);
    if (playlistUri) return { type: 'playlist', id: playlistUri[1] };

    const urlMatch = str.match(/open\.spotify\.com\/(track|playlist)\/([0-9A-Za-z]{22})/i);
    if (urlMatch) return { type: urlMatch[1], id: urlMatch[2] };

    const bareId = str.match(/^([0-9A-Za-z]{22})$/);
    if (bareId) return { type: 'track', id: bareId[1] };

    return null;
}


app.get('/api/search', async(req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (!q) return res.status(400).json({ error: 'q required' });

        const r = await spotifyFetch(`https://api.spotify.com/v1/search?type=track&limit=5&q=${encodeURIComponent(q)}`);
        const j = await r.json();
        if (!r.ok) return res.status(400).json(j);

        const items = (j.tracks?.items || []).map(t => ({
            uri: t.uri,
            id: t.id,
            name: t.name,
            artists: t.artists.map(a => a.name).join(', '),
            album: t.album?.name || '',
            durationMs: t.duration_ms,
            image: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || null
        }));
        res.json(items);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'search_failed'});
    }
});

app.get('/api/nowplaying', async (req, res) => {
    try {
        const r = await spotifyFetch('https://api.spotify.com/v1/me/player');
        if (r.status === 204) {
            return res.json({
                isPlaying: false,
                device: null,
                progressMs: 0,
                track: null
            });
        }

        let j = null;
        try {
            j = await r.json();
        } catch (_) {
            return res.status(502).json({ error: 'player_parse_failed' });
        }
        if (!r.ok) return res.status(r.status).json(j);

        const item = j && j.item ? j.item : null;
        res.json({
            isPlaying: j?.is_playing || false,
            device: j?.device?.name || null,
            progressMs: j?.progress_ms || 0,
            track: item ? {
            name: item.name,
            artists: item.artists.map(a => a.name).join(', '),
            uri: item.uri,
            durationMs: item.duration_ms,
            image: item.album?.images?.[1]?.url || item.album?.images?.[0]?.url || null
            } : null
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'failed_nowplaying' });
    }
});

app.post('/api/player/play', async (req, res) => {
    const r = await spotifyFetch('https://api.spotify.com/v1/me/player/play', { method: 'PUT' });
    if (!r.ok) return res.status(r.status).json(await r.json());
    res.json({ ok: true });
});

app.post('/api/player/pause', async (req, res) => {
    const r = await spotifyFetch('https://api.spotify.com/v1/me/player/pause', { method: 'PUT' });
    if (!r.ok) return res.status(r.status).json(await r.json());
    res.json({ ok: true });
});

app.post('/api/player/next', async (req, res) => {
    const r = await spotifyFetch('https://api.spotify.com/v1/me/player/next', { method: 'POST' });
    if (!r.ok) return res.status(r.status).json(await r.json());
    res.json({ ok: true });
});

app.post('/api/player/previous', async (req, res) => {
    const r = await spotifyFetch('https://api.spotify.com/v1/me/player/previous', {method: 'POST'});
    if (!r.ok) return res.status(r.status).json(await r.json());
    res.json({ ok: true });
});


app.post('/api/queue', async (req, res) => {
    try {
        const { uri, q } = req.body;

        let trackUri = null;
        const entity = parseSpotifyEntity(uri);

        if (entity?.type === 'track') {
            trackUri = `spotify:track:${entity.id}`;
        } else if (entity?.type === 'playlist') {
            return res.status(400).json({ error: 'playlist_use_shuffle' });
        }

        if (!trackUri && q) {
            //resolve top search tracks
            const r = await spotifyFetch(`https://api.spotify.com/v1/search?type=track&limit=1&q=${encodeURIComponent(q)}`);
            const j = await r.json();
            if (!r.ok) return res.status(r.status).json({ error: 'provide uri or q' });
            const t = j.tracks?.items?.[0];
            if (!t) return res.status(404).json({ error: 'no_match' });
            trackUri = t.uri;
        }

        if (!trackUri) return res.status(400).json({ error: 'missing_uri_or_query' });
        
        const url = `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(trackUri)}`;
        const r2 = await spotifyFetch(url, { method: 'POST' });
        if (!r2.ok) return res.status(r2.status).json(await r2.json());

        res.json({ ok: true, queued: trackUri });
        queueList.unshift({ uri: trackUri});

    } catch(e) {
        console.error(e);
        res.status(500).json({ error: 'queue_failed'});
    }
});

app.post('/api/playlist/shuffle', async (req, res) => {
    try {
        const { playlistUri } = req.body || {};
        const entity = parseSpotifyEntity(playlistUri);
        if (entity?.type !== 'playlist') {
            return res.status(400).json({ error: 'playlist_uri_required' });
        }

        const contextUri = `spotify:playlist:${entity.id}`;
        const shuffleResp = await spotifyFetch('https://api.spotify.com/v1/me/player/shuffle?state=true', { method: 'PUT' });
        if (!shuffleResp.ok) return res.status(shuffleResp.status).json(await shuffleResp.json());

        const playResp = await spotifyFetch('https://api.spotify.com/v1/me/player/play', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context_uri: contextUri })
        });
        if (!playResp.ok) return res.status(playResp.status).json(await playResp.json());

        res.json({ ok: true, contextUri });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'playlist_shuffle_failed' });
    }
});

app.get('/api/queue/history', (req, res) => {
    res.json({queueList});
});
