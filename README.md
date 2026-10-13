# Next Hour

Minute-by-minute rain forecast for the next hour, made by radar nowcasting:
track storms on live radar and project them forward to your exact location. Installable on
iPhone as a home-screen web app. No server or API keys.

## How it works

1. **Radar** — the last 60 minutes of NOAA NEXRAD base reflectivity (5-minute mosaic, ~1 km,
   clutter-filtered by the Iowa Environmental Mesonet), a 340 km box around you. Pixel
   colours are mapped back to exact dBZ with the N0Q palette (`data.js`).
2. **Cleaning** — echoes under 15 dBZ and isolated speckle are dropped; reflectivity is
   converted to rain rate with Marshall-Palmer (Z = 200R^1.6).
3. **Motion** — frames 15 minutes apart are matched block by block (correlation tracking,
   coarse-to-fine with sub-pixel fitting). Outlier vectors are removed and the rest are
   smoothed into a motion field (`nowcast.js`).
4. **Extrapolation** — from your location the app traces back along the motion field to see
   which rain arrives each minute. A neighbourhood that widens with lead time gives the
   probability and intensity.
5. **Self-check** — each update re-forecasts the latest radar frame from 30 minutes earlier
   and scores it, shown next to a "storms stand still" baseline.
6. **Beyond radar** — offshore or far from a radar site, the forecast blends toward the
   Open-Meteo / HRRR model, which also gives the temperature that picks rain or snow.

## Files

| File | Purpose |
|---|---|
| `nowcast.js` | Tracking and extrapolation engine (no browser APIs) |
| `radar.js` | Fetches and decodes radar frames, radar-site distance |
| `model.js` | Open-Meteo model backup |
| `app.js` | UI: summary, chart, radar map, alerts |
| `data.js` | N0Q colour palette and NEXRAD site list (generated) |
| `tests.html` | Engine tests on synthetic storms; open in a browser |

Testing a location: `index.html?lat=39.0&lon=-97.0`.

## Limits

- Radar coverage is the lower 48 plus coastal waters (about 150–250 km offshore).
- Alerts only work while the app is open; background alerts would need a push server.
- Storms forming or dying within the hour are not predicted (a limit of any radar
  nowcast that moves existing echoes forward).
