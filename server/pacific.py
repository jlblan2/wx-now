"""Pacific Ocean mask for the server's forecast grids.

Next Hour covers the Atlantic side only (US East Coast, Gulf of America, Bahamas,
Caribbean, Bermuda). The polygon follows the Pacific coast of the Americas a little
offshore, from Ecuador to British Columbia, so grid cells over the Pacific (including
the Gulf of California) are blanked out of every product.
"""
import numpy as np

# (lon, lat), offshore of the Pacific coast, closed back along 130W.
PACIFIC = [
    (-130.0, -5.0), (-81.5, -5.0), (-80.6, -1.0), (-80.2, 0.8), (-79.2, 1.6), (-77.9, 3.6),
    (-77.7, 6.6), (-78.3, 7.9), (-79.2, 8.3), (-80.1, 7.3), (-81.2, 7.6), (-81.9, 8.1), (-82.8, 8.2), (-83.4, 8.5),
    (-84.6, 9.4), (-84.8, 10.0), (-85.3, 10.25), (-85.5, 9.8),
    (-85.9, 10.5), (-87.3, 12.4), (-88.6, 13.1), (-90.6, 13.8), (-92.5, 14.4),
    (-94.3, 16.0), (-96.6, 15.6), (-98.7, 16.3), (-100.6, 17.2), (-104.5, 19.0),
    (-105.6, 20.5), (-105.3, 21.7), (-106.4, 23.2), (-108.6, 25.6), (-111.0, 28.6),
    (-114.6, 31.7), (-117.2, 32.5), (-118.5, 34.0), (-120.7, 34.5), (-122.0, 36.6),
    (-122.7, 37.8), (-123.9, 39.5), (-124.5, 42.0), (-124.3, 46.2), (-124.9, 48.4),
    (-125.6, 50.0), (-128.0, 52.0), (-130.0, 54.5), (-130.0, 61.0), (-140.0, 61.0),
    (-140.0, -5.0),
]


def pacific_mask(lats, lons):
    """Boolean grid (len(lats) x len(lons)), True over the Pacific."""
    lat, lon = np.meshgrid(np.asarray(lats, float), np.asarray(lons, float), indexing='ij')
    inside = np.zeros(lat.shape, bool)
    pts = PACIFIC
    for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]):
        crosses = (y1 > lat) != (y2 > lat)
        with np.errstate(divide='ignore', invalid='ignore'):
            xi = (x2 - x1) * (lat - y1) / (y2 - y1) + x1
        inside ^= crosses & (lon < xi)
    return inside
