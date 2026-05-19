# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Start server (default)**: `npm start` — runs `node server.js`, listens on `0.0.0.0:5173`
- **Start with public tunnel**: `npm run start:tunnel` — uses Cloudflare Tunnel for public internet access (mobile data, different networks)
- **Custom port**: `PORT=3000 npm start`
- **macOS quick start**: double-click `start-local.command`
- **Windows quick start**: run `start-local-windows.bat`
- **macOS with tunnel**: double-click `start-with-tunnel.command`
- **Windows with tunnel**: run `start-with-tunnel.bat`

No build step, test runner, or lint setup exists.

## Architecture

Pure SPA + lightweight Node.js HTTP server. `index.html` is a monolithic file with inlined CSS and JS. No build tools, frameworks, or transpilation.

### Backend (`server.js`)

- Native `http` module, zero dependencies.
- Static files served from repo root (`/` and `/join` both map to `index.html`).
- JSON file persistence at `data/lottery-data.json`.
- Atomic writes: temp file first, then `fs.rename` to target.
- Concurrent writes serialized via a `writeQueue` promise chain.
- State defaults are merged with saved state on read (non-destructive schema evolution).

### API surface

| Route | Description |
|-------|-------------|
| `GET /api/state` | Full application state (participants, winners) |
| `GET /api/config` | Server URLs (includes LAN IPs) for QR code generation |
| `POST /api/participants` | Register one participant (`{ name, source? }`) |
| `POST /api/participants/import` | Bulk import (`{ names: string[] }` or raw string) |
| `DELETE /api/participants` | Clear all participants and winners |
| `POST /api/winners/reset` | Reset only winners, keep participants |
| `POST /api/draw` | Draw an award (`{ awardKey: "first" | "second" | "third" }`) |
| `GET /api/export.csv` | Export participants as UTF-8 CSV with BOM |

### State shape

```json
{
  "participants": [
    { "id": "uuid", "name": "...", "source": "scan|manual|import", "createdAt": "ISO" }
  ],
  "winners": {
    "first": [],
    "second": [],
    "third": []
  },
  "updatedAt": null
}
```

### Award configuration (hardcoded)

| Key | Label | Count |
|-----|-------|-------|
| `first` | 一等奖 | 1 |
| `second` | 二等奖 | 2 |
| `third` | 三等奖 | 3 |

Participants who have already won are excluded from subsequent draws.

### Frontend (`index.html`)

- Single-file HTML with inline CSS and JS. Edit directly — no build.
- CDNs: PeerJS (real-time sync between display and phones), QRious (QR codes).
- Routing: `/` shows the big-screen lottery dashboard; `/join` shows the mobile registration form. Both are served from the same `index.html` file.
- Auto-join via PeerJS on page load; falls back to polling (`/api/state`) when WebRTC fails.

## Data safety

- `data/lottery-data.json` is gitignored and survives server restarts.
- Deleting `data/` resets to empty state on next request.
- Max participants: 1200. Max request body: 1 MB.
