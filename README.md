# Win Audio Cast

Small WebRTC audio broadcast app for Windows browsers.

## What it does

- `/broadcast` is the broadcaster console.
- `/listen` is the public listening page.
- The broadcaster password is read from `config/broadcaster-password.txt`.
- ICE servers are read from `config/ice-servers.json`.

## Run locally

```bash
npm install
npm start
```

The app listens on `127.0.0.1:3000`.

## Broadcast flow

1. Open `http://localhost:3000/broadcast`.
2. Enter the password from `config/broadcaster-password.txt`.
3. Click `Start broadcast`.
4. In Chrome or Edge on Windows, share a screen or tab and enable the audio share option.
5. Listeners open `http://localhost:3000/listen` and click `Start listening`.

## Deploy behind HTTPS

Use a reverse proxy such as Caddy. A sample `Caddyfile` is included.

If cross-network listeners cannot connect reliably, add TURN servers in `config/ice-servers.json`.
