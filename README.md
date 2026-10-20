# Wx Now

Minute-by-minute rain forecast for the next hour, built the way the original Dark Sky did it:
track storms on live radar and project them forward to your exact location. Installable on
iPhone as a home-screen web app; see [How to add Wx Now to iPhone](How%20to%20add%20Wx%20Now%20to%20iPhone.txt).

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
| `storms.js` | NHC Atlantic tropical storms (cone, track, wind field, watches/warnings) and per-place threat checks |
| `surge.js` | NHC storm surge: planning maps by category, live surge forecast, risk at a point |
| `marine.js` | NWS Gulf and Atlantic marine zone forecasts and alerts (api.weather.gov); offshore zones read from the Offshore Waters Forecasts (OFF NT1-NT5) |
| `compare.js` | Second opinion: NOAA GFS / GFS-Wave vs Navy NAVGEM / WAVEWATCH III, daily, with disagreements flagged |
| `passage.js` | Sailing weather charts (wind barbs, waves, isobars + rain, visibility) for the East Coast, Gulf, Bahamas, Caribbean and Bermuda |
| `outlook.js` | NHC Atlantic Tropical Weather Outlook: text (TWO AT) and areas to watch with 2/7-day chances |
| `seatemp.js` | Water temperature card: Open-Meteo marine sea surface temperature at the spot and the nearest NDBC buoys (via `/api/buoys`) |
| `tides.js`, `tidestations.js` | NOAA CO-OPS tide predictions (2,301 Atlantic-side stations) and measured water levels from the nearest of 220 gauges, loaded only in Seas & swell |
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
- Storms forming or dying within the hour are not predicted (same as the original
  Dark Sky nowcast).

## Alert server

`server/` runs on an Oracle Cloud Always Free Ubuntu VM. It reuses the app's own modules, so
alerts give the same answer as the app. Every 5 minutes it forecasts each subscriber's saved
places and last-known location and sends a push about 15 minutes before rain (at most once
per rain event per place). Install or update on the VM with:

```
curl -fsSL https://raw.githubusercontent.com/jlblan2/wx-now/main/server/install.sh | sudo bash
```

The VM pulls new commits from GitHub every 30 minutes. It also fetches each new U.S. Navy
(FNMOC) run from NOAA NOMADS hourly (`server/navy/fetch_navy.py`): NAVGEM and the Navy
WAVEWATCH III ensemble control member, 0-120 h, cut to 0-60N 130-50W, served to the app
at `/api/navy/*` for the wave map and the second-opinion card. For the Sailing weather charts it
also fetches each GFS run (`server/passage/fetch_gfs.py`, NOMADS grib filter: 10 m wind, gusts,
pressure, rain rate, visibility, sea surface temperature, GFS-Wave height/period/direction; 8-47N 100-58W, 0.25 deg,
3-hourly to 168 h), served gzipped at `/api/passage/*` alongside the Navy run in the same layout. Measured water
levels for all 220 Atlantic-side NOAA gauges come from a gentle 30-minute sweep
(`server/waterlevels.js`, 3 s between requests: NOAA's API gateway returns 403 on bursts)
and are served at `/api/waterlevels`. NDBC buoy reports (`server/buoys.js`, one
`latest_obs.txt` download every 30 minutes, Pacific excluded) are served at `/api/buoys`. After each refresh `server/watertemp.js` alerts subscribers when the water at the buoy
nearest a watched place has warmed or cooled by their chosen amount (`POST /api/watertemp`). Every hour `server/windalerts.js` checks the Open-Meteo hourly wind forecast for
each saved place and alerts when sustained wind in the next 24 hours reaches the subscriber's
threshold (`POST /api/wind`, knots). Every 3 hours `server/tidealerts.js` checks NOAA's predicted highs and
lows for the next 48 hours at the tide station nearest each saved place and alerts on highs above
MHHW (or the minor flood level) and lows below MLLW by the subscriber's margin (`POST /api/tides`). Every 30 minutes `server/fogalerts.js` checks the 12-hour visibility
forecast and NWS fog/smoke advisories (`alerts/active?point=`) at each saved place (`POST /api/fog`, nm). Every 5 minutes `server/thunder.js` runs `server/lightning/glm.py`
(GOES-19 GLM L2 flash files from the public `noaa-goes19` S3 bucket, read with h5py) and alerts on
lightning near each watched place, with a 30-minute all-clear, plus NWS severe thunderstorm and
tornado watches/warnings at the place (`POST /api/lightning`, miles). Hourly, `server/ripalerts.js` parses the NWS Surf Zone
Forecast (SRF) for each watched place's beach zone (`/points` lookup) and alerts on moderate/high
rip current risk, plus High Surf and Beach Hazards alerts (`POST /api/rip`). Every 4 minutes `server/hailalerts.js` runs
`server/hail/mesh.py` (MRMS MESH_Max_30min from the public `noaa-mrms-pds` bucket; the 16-bit PNG
inside the GRIB2 is decoded with Pillow, ~120 MB instead of ~340 MB with eccodes) and alerts on
radar hail within 10 miles, NWS warnings with hail, and the SPC Day 1 hail outlook (`POST /api/hail`, inches). Status: `https://<server>/api/status`.
Tests: `node server/test.js`.

## Coverage

Atlantic side only: Pacific storms (EP/CP), Pacific storm-surge regions and Pacific Ocean
cells of the Navy and GFS grids (`server/pacific.py` mask) are excluded.
