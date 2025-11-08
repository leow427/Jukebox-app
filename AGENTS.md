# Repository Guidelines

## Project Structure & Module Organization
- `Backend/` hosts the HTTPS Express server in `server.js`, plus PKCE token helpers and Spotify-facing routes under `/api`. Certificates (`127.0.0.1*.pem`) and `tokens.json` live here; keep them local-only.
- `Frontend/index.html` is the lightweight queue UI served statically. Extend behaviour with inline modules or move scripts into a new `Frontend/js/` directory as the codebase grows.
- Shared `node_modules/` is already present; prefer running backend commands from `Backend/` to respect scoped dependencies.

## Build, Test, and Development Commands
- `cd Backend && npm install` installs Express, node-fetch, dotenv and friends; rerun after package updates.
- `cd Backend && npm start` launches the HTTPS server on `https://127.0.0.1:8888` using the bundled certs.
- `curl -k https://127.0.0.1:8888/health` verifies the service is healthy before triggering Spotify auth through `/login`.

## Coding Style & Naming Conventions
- Use ES modules (`import`/`export`) and arrow functions for route handlers. Match the existing two-space indentation inside blocks and keep trailing semicolons.
- Name helpers descriptively (`spotifyFetch`, `refreshAccessToken`) and keep filenames lowercase with dashes (`player-controls.js`) if you split modules.
- Store secrets in `.env` (never in Git) with uppercase snake case keys such as `SPOTIFY_CLIENT_ID` and `REDIRECT_URI`.

## Testing Guidelines
- There is no automated suite yet; add integration tests with Jest or Vitest plus Supertest when touching API flows. Co-locate specs in `Backend/__tests__/` mirroring route files.
- Until tests exist, document manual verification steps in PRs: run the health check, complete `/login`, queue a track, and confirm `/api/nowplaying`.
- Keep `tokens.json` out of commits; regenerate locally if authentication fails.

## Commit & Pull Request Guidelines
- Git history currently uses short imperative subjects (`Initial commit`). Follow that pattern: e.g., `Add queue retry guard`.
- For PRs, include: purpose, high-level changes, manual test notes, and any Spotify app configuration steps. Attach screenshots or terminal logs for UI/API changes when relevant.
- Link GitHub issues or Spotify ticket IDs when available, and request at least one review before merge.

## Environment & Security Tips
- Ensure `.env` aligns with your Spotify app’s redirect URI (`https://localhost:8888/callback` pattern). Update certificates if you change hostnames.
- Delete or rotate `tokens.json` whenever credentials leak or you switch accounts; the server will obtain fresh tokens during the next `/login`.
