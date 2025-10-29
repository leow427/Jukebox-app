import express from 'express';
import https from 'https';
import fs from 'fs';
import dotenv from 'dotenv';
import crypto from 'crypto';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
let pkce = {verifier: null};

//.env variables
const CLIENT_ID = (process.env.SPOTIFY_CLIENT_ID || '').trim();
const REDIRECT_URI = (process.env.REDIRECT_URI || '').trim();


if (!CLIENT_ID || !/^https:\/\/.+\/callback$/.test(REDIRECT_URI)) {
  throw new Error('REDIRECT_URI must be https and end with /callback (e.g., https://localhost:8888/callback).');
}

app.use(express.json());

//sets up a path to verify server is running
app.get('/health', (req,res) => res.json({ ok: true }));

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
        const accessToken = data.access_token
        const refreshToken = data.refresh_token
        const expiresIn = data.expires_in;

        

        console.log('Access Token:', data.access_token);
        console.log('Refresh Token:', data.refresh_token);

        return res.type('text/plain').send('Tokens received! Check your terminal')

    } catch (error) {
            console.error('Token exchange error:', error);
            return res.status(500).send('Token exhange error');
        }
});
