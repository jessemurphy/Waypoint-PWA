# Waypoint — a personal check-in PWA

A Swarm-style check-in log that's entirely yours. Tap the big stamp button, pick from
nearby places (or name one yourself), and build a history of everywhere you go — stored
locally on your device, no accounts, no tracking, no server.

## Features

- **One-tap check-in**: uses your phone's GPS, then looks up named places within ~220m
  from OpenStreetMap (via the Overpass API — free, no API key required)
- **Custom places**: no network or nothing nearby? Type any name; coordinates are saved
  regardless
- **History as passport stamps**, grouped by day, with time, coordinates, and category
- **Stats**: total stamps, unique places, current day-streak
- **"Your regulars"**: your most-visited places, Swarm-mayor style
- **Edit/delete** any stamp (fix a name, adjust the time)
- **Export/import JSON** — the format is deliberately simple (`ts`, `name`, `lat`, `lon`,
  `category`) so it can merge into a bigger location archive easily

## Running it

Service workers, installability, and **geolocation all require https** (localhost is
exempt for testing). Same drill as any static PWA:

```
cd waypoint-pwa
python3 -m http.server 8080     # local test at http://localhost:8080
```

For real phone use, host it on GitHub Pages (this repo deploys from `main`
— push to `main` and Pages redeploys in a minute or two). Then on iPhone: open the URL in Safari →
Share → Add to Home Screen.

**iOS note:** the first check-in will prompt for location permission. If you decline it
once and change your mind, it's Settings → Privacy & Security → Location Services →
Safari Websites (or the installed app's name).

## Data notes

- Storage is `localStorage` under the key `waypoint:data:v1`
- Place lookup queries go directly from your device to `overpass-api.de` — the only data
  sent is your coordinates for the radius search, nothing is stored server-side by this app
- Overpass is a free community service; if it's busy, lookup can occasionally fail —
  the app degrades to "name it yourself" rather than blocking the check-in

## Photos and orientation

A stamp's photo is downscaled on the phone (long edge 1280, q0.8) and sent as a
data URL. **Rotate** on the edit sheet turns it in quarter-turns and, once you
save, re-sends it — the server REPLACES a re-sent photo, so the site ends up
with the same orientation you see here.

Rotation only travels PHONE -> SITE. Waypoint shows its own local copy from
IndexedDB and never reads the photo back, so rotating on the website does not
reach the phone. If the two disagree, rotate here and save.

Turns are always applied to the original rather than to the last result, so
four taps returns exactly the photo you started with and sends nothing.
