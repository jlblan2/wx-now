#!/usr/bin/env python3
"""
Photograph the screens for the user's manual:

    python tools/shoot.py [scene ...]

Serve the project folder first (python -m http.server 8430 in the project folder, or the
"wxnow" entry in Z:\\Claude\\.claude\\launch.json). Each scene opens the app at a fixed place
(index.html?lat=..&lon=..&tab=..) in headless Edge, which this script drives over its DevTools
connection: it waits until the scene's data has loaded, scrolls to or opens the part being
shown, then photographs it at phone size (390 x 800 points, 2x) to tools/screens/<scene>.jpg.
The weather is live, so the pictures change from day to day.
Uses only the standard library and Pillow.
"""
import base64
import io
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request

from PIL import Image

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
BASE = "http://localhost:8430/index.html"
PORT = 9334
HERE = os.path.dirname(os.path.abspath(__file__))
SCREENS = os.path.join(HERE, "screens")

HOME = "x=home"                      # the saved place "Home" (Destin, Florida), picked in the place bar
BOSTON = "lat=42.33&lon=-70.95"      # Boston Harbor: cold water
DARWIN = "lat=-12.46&lon=130.84"     # Darwin, Australia: a hot, stormy week

# Sample saved places so the place bar and Settings show some.
PLACES = [{"name": "Home", "lat": 30.39, "lon": -86.50}, {"name": "Marina", "lat": 30.40, "lon": -87.21}]

# JavaScript run in the app's page.
LOCAL_READY = ("document.getElementById('summary').textContent !== 'Loading…' && "
               "!document.getElementById('refreshBtn').classList.contains('spin') && "
               "!document.getElementById('dailyCard').hidden")
PEOPLE_READY = ("document.querySelectorAll('.fx-day').length > 0 && "
                "!/Loading/.test(document.getElementById('waterBody').textContent) && "
                "!/Loading/.test(document.getElementById('pollenBody').textContent)")
SCROLL = "(() => {{ const e = {sel}; e.scrollIntoView({{block: 'start'}}); scrollBy(0, -{pad}); }})()"


def scroll_to(sel, pad=150):
    return SCROLL.format(sel=sel, pad=pad)


# name: (query, ready expression, action, extra wait in seconds)
SCENES = {
    "local-top": (f"{HOME}&tab=local", LOCAL_READY, "scrollTo(0, 0)", 1),
    "local-hourly": (f"{HOME}&tab=local", LOCAL_READY, scroll_to("document.getElementById('hourlyCard')"), 1),
    "local-daily": (f"{HOME}&tab=local", LOCAL_READY, scroll_to("document.getElementById('dailyCard')"), 1),
    "local-map": (f"{HOME}&tab=local", LOCAL_READY + " && document.querySelectorAll('.leaflet-tile-loaded').length > 4",
                  scroll_to("document.getElementById('mapCard')", 160), 4),
    "people-top": (f"{HOME}&tab=people", PEOPLE_READY, "scrollTo(0, 0)", 1),
    "people-hot": (f"{DARWIN}&tab=people", PEOPLE_READY,
                   "(() => { const d = document.querySelectorAll('.fx-day'); d[0].open = false; d[2].open = true;"
                   " d[2].scrollIntoView({block: 'start'}); scrollBy(0, -150); })()", 1),
    "people-hot-advice": (f"{DARWIN}&tab=people", PEOPLE_READY,
                          "(() => { const d = document.querySelectorAll('.fx-day'); d[0].open = false; d[2].open = true;"
                          " d[2].querySelector('.fx-advice').scrollIntoView({block: 'start'}); scrollBy(0, -150); })()", 1),
    "people-air": (f"{HOME}&tab=people", PEOPLE_READY + " && !document.getElementById('aqCard').hidden",
                   scroll_to("document.getElementById('aqCard')"), 1),
    "people-water": (f"{BOSTON}&tab=people", PEOPLE_READY, scroll_to("document.getElementById('waterCard')"), 1),
    "people-guide": (f"{HOME}&tab=people", PEOPLE_READY,
                     "(() => { const g = document.querySelectorAll('#fxGuide details'); g[1].open = true;"
                     " document.getElementById('fxGuide').scrollIntoView({block: 'start'}); scrollBy(0, -150); })()", 1),
    "storms": (f"{HOME}&tab=storms", "!/Loading/.test(document.getElementById('outlookBody').textContent)",
               "scrollTo(0, 0)", 2),
    "storms-map": (f"{HOME}&tab=storms", "!/Loading/.test(document.getElementById('outlookBody').textContent) && "
                   "document.querySelectorAll('.leaflet-tile-loaded').length > 4",
                   scroll_to("document.getElementById('mapCard')", 160), 4),
    "seas-marine": (f"{HOME}&tab=seas", "!/Loading/.test(document.getElementById('marineBody').textContent)",
                    "scrollTo(0, 0)", 1),
    "seas-tides": (f"{HOME}&tab=seas", "!/Loading/.test(document.getElementById('tideNow').textContent)",
                   scroll_to("document.getElementById('tideCard')"), 2),
    "seas-water": (f"{HOME}&tab=seas", "!/Loading/.test(document.getElementById('wtNow').textContent)",
                   scroll_to("document.getElementById('waterTempCard')"), 2),
    "seas-passage": (f"{HOME}&tab=seas", "document.getElementById('pwLabel').textContent.length > 0",
                     scroll_to("document.getElementById('passageCard')"), 6),
    "settings": (f"{HOME}&tab=local", LOCAL_READY, "document.getElementById('settingsBtn').click(); scrollTo(0, 0)", 1),
    "settings-alerts": (f"{HOME}&tab=local", LOCAL_READY,
                        "document.getElementById('settingsBtn').click();"
                        + scroll_to("document.getElementById('pushTornado').closest('label')", 70), 1),
    "settings-places": (f"{HOME}&tab=local", LOCAL_READY,
                        "document.getElementById('settingsBtn').click();"
                        + scroll_to("document.getElementById('placeList')", 110), 1),
}


class DevTools:
    """Just enough of a WebSocket client to send DevTools commands and read the replies."""

    def __init__(self, url):
        host, rest = url.split("://", 1)[1].split("/", 1)
        h, p = host.split(":")
        self.s = socket.create_connection((h, int(p)), timeout=600)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f"GET /{rest} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            head += self.s.recv(1)
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise RuntimeError(head.decode(errors="replace"))
        self.n = 0

    def _read(self, k):
        out = b""
        while len(out) < k:
            chunk = self.s.recv(k - len(out))
            if not chunk:
                raise RuntimeError("DevTools connection closed")
            out += chunk
        return out

    def _send(self, text):
        data = text.encode()
        mask = os.urandom(4)
        n = len(data)
        head = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else
                                bytes([0x80 | 126]) + struct.pack(">H", n) if n < 65536 else
                                bytes([0x80 | 127]) + struct.pack(">Q", n))
        self.s.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _recv(self):
        msg = b""
        while True:
            b0, b1 = self._read(2)
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            msg += self._read(n)
            if b0 & 0x80:
                return msg.decode()

    def call(self, method, **params):
        self.n += 1
        self._send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            reply = json.loads(self._recv())
            if reply.get("id") == self.n:
                if "error" in reply:
                    raise RuntimeError(f"{method}: {reply['error']}")
                return reply.get("result", {})

    def js(self, expression):
        return self.call("Runtime.evaluate", expression=expression)["result"].get("value")


def main(names):
    os.makedirs(SCREENS, exist_ok=True)
    work = tempfile.mkdtemp(prefix="wxnow-")
    subprocess.Popen([EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
                      f"--user-data-dir={os.path.join(work, 'profile')}", f"--remote-debugging-port={PORT}",
                      "--window-size=390,800", "about:blank"])
    for _ in range(60):
        try:
            pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
            page = next(p for p in pages if p.get("type") == "page")
            break
        except Exception:
            time.sleep(1)
    else:
        sys.exit("headless Edge did not start")
    dt = DevTools(page["webSocketDebuggerUrl"])
    try:
        dt.call("Emulation.setDeviceMetricsOverride", width=390, height=800, deviceScaleFactor=2, mobile=True)
        # The phone is in Destin with location allowed, and has accepted the disclaimer.
        dt.call("Browser.grantPermissions", permissions=["geolocation"])
        dt.call("Emulation.setGeolocationOverride", latitude=30.39, longitude=-86.50, accuracy=30)
        dt.call("Page.navigate", url=BASE)
        time.sleep(3)
        dt.js("localStorage.clear();"
              "localStorage.setItem('disclaimer.Wx Now.v1', 'accepted');"
              f"localStorage.setItem('places', {json.dumps(json.dumps(PLACES))});"
              "localStorage.setItem('activePlace', '\"Home\"');"
              "localStorage.setItem('units', '\"us\"');")
        for name in names:
            query, ready, action, extra = SCENES[name]
            start = time.time()
            dt.call("Page.navigate", url=f"{BASE}?{query}")
            time.sleep(3)
            while time.time() - start < 120:
                try:
                    if dt.js(f"!!({ready})"):
                        break
                except RuntimeError:
                    pass
                time.sleep(1)
            else:
                print("timed out", name, "(shot anyway)", flush=True)
            time.sleep(2)
            dt.js(action)
            time.sleep(1 + extra)
            png = base64.b64decode(dt.call("Page.captureScreenshot", format="png")["data"])
            Image.open(io.BytesIO(png)).convert("RGB").save(os.path.join(SCREENS, name + ".jpg"), quality=86)
            print(f"shot {name} ({time.time() - start:.0f} s)", flush=True)
    finally:
        try:
            dt.call("Browser.close")
        except Exception:
            pass
        time.sleep(2)
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main(sys.argv[1:] or list(SCENES))
