# Next Hour

Minute-by-minute rain forecast for the next hour, made by radar nowcasting:
track storms on live radar and project them forward to your exact location. Installable on
iPhone as a home-screen web app; see [How to add Next Hour to iPhone](How%20to%20add%20Next%20Hour%20to%20iPhone.txt).

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

The same Open-Meteo request also supplies the 24-hour and 7-day forecasts (temperature,
chance of precipitation, wind and gusts).

## Files

| File | Purpose |
|---|---|
| `nowcast.js` | Tracking and extrapolation engine (no browser APIs) |
| `radar.js` | Fetches and decodes radar frames, radar-site distance |
| `doppler.js` | Doppler wind arrows: each radar's VAD Wind Profile (Level III NVW) from NOAA's AWS archive |
| `storms.js` | NHC tropical storms (cone, track, wind field, watches/warnings) and per-place threat checks |
| `surge.js` | NHC storm surge: planning maps by category, live surge forecast, risk at a point |
| `marine.js` | NWS Gulf and Atlantic marine zone forecasts and marine alerts (api.weather.gov) |
| `compare.js` | Second opinion: NOAA GFS / GFS-Wave vs Navy NAVGEM / WAVEWATCH III, daily, with disagreements flagged |
| `passage.js` | Sailing weather charts (wind barbs, waves, isobars + rain, visibility) for the East Coast, Gulf, Bahamas and Caribbean |
| `model.js` | Open-Meteo: model backup, hourly and 7-day forecasts |
| `app.js` | UI: summary, chart, hourly and 7-day, radar map, alerts |
| `data.js` | N0Q colour palette and NEXRAD site list (generated) |
| `forecast.js` | Forecast pipeline and summary text, shared with the alert server |
| `push.js` | Closed-app alert settings and push subscription |
| `config.js` | Alert server address |
| `server/` | Alert server (Node.js): runs the same forecast every 5 minutes and sends Web Push |
| `tests.html` | Engine tests on synthetic storms; open in a browser |

Testing a location: `index.html?lat=39.0&lon=-97.0`.

## Limits

- Radar coverage is the lower 48 plus coastal waters (about 150–250 km offshore).
- Storms forming or dying within the hour are not predicted (a limit of any radar
  nowcast that moves existing echoes forward).

## Alert server

`server/` runs on an Oracle Cloud Always Free Ubuntu VM. It reuses the app's own modules, so
alerts give the same answer as the app. Every 5 minutes it forecasts each subscriber's saved
places and last-known location and sends a push about 15 minutes before rain (at most once
per rain event per place). Install or update on the VM with:

```
curl -fsSL https://raw.githubusercontent.com/jlblan2/next-hour/main/server/install.sh | sudo bash
```

The VM pulls new commits from GitHub every 30 minutes. It also fetches each new U.S. Navy
(FNMOC) run from NOAA NOMADS hourly (`server/navy/fetch_navy.py`): NAVGEM and the Navy
WAVEWATCH III ensemble control member, 0-120 h, cut to 0-60N 130-50W, served to the app
at `/api/navy/*` for the wave map and the second-opinion card. For the Sailing weather charts it
also fetches each GFS run (`server/passage/fetch_gfs.py`, NOMADS grib filter: 10 m wind, gusts,
pressure, rain rate, visibility, GFS-Wave height/period/direction; 8-47N 100-58W, 0.25 deg,
3-hourly to 168 h), served gzipped at `/api/passage/*` alongside the Navy run in the same layout. Status: `https://<server>/api/status`.
Tests: `node server/test.js`.
