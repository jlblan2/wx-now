#!/usr/bin/env python3
"""
Build the user's manual:

    python tools/make_guide.py

Writes "Wx Now Users Manual.docx" in the project folder, then uses LibreOffice (if installed)
to make the .doc and .pdf copies. The app links the PDF from Settings and keeps it for offline
use (sw.js). Screenshots come from tools/screens/ (made by tools/shoot.py). Needs python-docx.
"""
import os
import subprocess
from datetime import date

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

ADDRESS = "https://jlblan2.github.io/wx-now/"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
SCREENS = os.path.join(HERE, "screens")
OUT = os.path.join(ROOT, "Wx Now Users Manual.docx")
SOFFICE = r"C:\Program Files\LibreOffice\program\soffice.exe"

NAVY = RGBColor(0x0A, 0x2A, 0x4A)
TEAL = RGBColor(0x0E, 0x7C, 0x72)
GREY = RGBColor(0x55, 0x5F, 0x6B)
FONT = "Arial"

doc = Document()

# ── page and styles ──────────────────────────────────────────────────────────
sec = doc.sections[0]
sec.page_width, sec.page_height = Inches(8.5), Inches(11)
sec.left_margin = sec.right_margin = Inches(1)
sec.top_margin = sec.bottom_margin = Inches(0.9)


def style(name, size, bold=False, color=None, before=0, after=6, keep=False):
    s = doc.styles[name]
    s.font.name = FONT
    s.element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    s.font.size = Pt(size)
    s.font.bold = bold
    s.font.italic = False
    if color is not None:
        s.font.color.rgb = color
    pf = s.paragraph_format
    pf.space_before, pf.space_after = Pt(before), Pt(after)
    pf.keep_with_next = keep
    return s


style("Normal", 11, after=6).paragraph_format.line_spacing = 1.12
style("Title", 28, bold=True, color=NAVY, after=4)
style("Subtitle", 14, color=TEAL, after=18)
style("Heading 1", 18, bold=True, color=NAVY, before=18, after=8, keep=True)
style("Heading 2", 14, bold=True, color=TEAL, before=14, after=6, keep=True)
style("Heading 3", 12, bold=True, color=NAVY, before=10, after=4, keep=True)
style("List Bullet", 11, after=3)
style("Caption", 9, color=GREY, after=10)


def para(text="", bold_lead=None, style_name=None, align=None, after=None, italic=False, color=None):
    """A paragraph. bold_lead is put in bold in front of the text."""
    p = doc.add_paragraph(style=style_name)
    if bold_lead:
        p.add_run(bold_lead).bold = True
    r = p.add_run(text)
    r.italic = italic
    if color is not None:
        r.font.color.rgb = color
    if align is not None:
        p.alignment = align
    if after is not None:
        p.paragraph_format.space_after = Pt(after)
    return p


def h1(text):
    return doc.add_heading(text, level=1)


def h2(text):
    return doc.add_heading(text, level=2)


def h3(text):
    return doc.add_heading(text, level=3)


def bullets(items):
    for item in items:
        p = doc.add_paragraph(style="List Bullet")
        if isinstance(item, tuple):
            p.add_run(item[0]).bold = True
            p.add_run(item[1])
        else:
            p.add_run(item)


def steps(items):
    """Numbered steps, typed out so every list starts again at 1."""
    for i, item in enumerate(items, 1):
        p = doc.add_paragraph()
        pf = p.paragraph_format
        pf.left_indent, pf.first_line_indent = Inches(0.35), Inches(-0.3)
        pf.space_after = Pt(4)
        p.add_run(f"{i}.").bold = True
        p.add_run("\t")
        pf.tab_stops.add_tab_stop(Inches(0.35))
        if isinstance(item, tuple):
            p.add_run(item[0]).bold = True
            p.add_run(item[1])
        else:
            p.add_run(item)


def shade(cell, hex_fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_fill)
    tc_pr.append(shd)


def cell_margins(table, top=70, bottom=70, left=110, right=110):
    tbl_pr = table._tbl.tblPr
    mar = OxmlElement("w:tblCellMar")
    for side, val in (("top", top), ("left", left), ("bottom", bottom), ("right", right)):
        el = OxmlElement(f"w:{side}")
        el.set(qn("w:w"), str(val))
        el.set(qn("w:type"), "dxa")
        mar.append(el)
    tbl_pr.append(mar)


def note(text, lead="Note: ", fill="FFF4D6"):
    """A shaded one-cell box for warnings and tips."""
    t = doc.add_table(rows=1, cols=1)
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.style = "Table Grid"
    cell_margins(t, 90, 90, 140, 140)
    cant = OxmlElement("w:cantSplit")             # keep the box on one page
    cant.set(qn("w:val"), "true")
    t.rows[0]._tr.get_or_add_trPr().append(cant)
    c = t.rows[0].cells[0]
    c.width = Inches(6.5)
    shade(c, fill)
    p = c.paragraphs[0]
    p.paragraph_format.space_after = Pt(0)
    p.add_run(lead).bold = True
    p.add_run(text)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


def table(headers, rows, widths):
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False
    cell_margins(t)
    for i, w in enumerate(widths):          # the grid widths, which LibreOffice goes by
        t.columns[i].width = Inches(w)
    for i, text in enumerate(headers):
        c = t.rows[0].cells[i]
        c.width = Inches(widths[i])
        shade(c, "0A2A4A")
        p = c.paragraphs[0]
        p.paragraph_format.space_after = Pt(0)
        r = p.add_run(text)
        r.bold = True
        r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
    for n, row in enumerate(rows):
        new_row = t.add_row()
        cant = OxmlElement("w:cantSplit")          # never break a row across two pages
        cant.set(qn("w:val"), "true")
        new_row._tr.get_or_add_trPr().append(cant)
        cells = new_row.cells
        for i, text in enumerate(row):
            cells[i].width = Inches(widths[i])
            if n % 2:
                shade(cells[i], "F1F5F9")
            p = cells[i].paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            r = p.add_run(text)
            if i == 0:
                r.bold = True
    # repeat the header row on each page
    tr_pr = t.rows[0]._tr.get_or_add_trPr()
    hdr = OxmlElement("w:tblHeader")
    hdr.set(qn("w:val"), "true")
    tr_pr.append(hdr)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return t


def screens(items, width=2.25):
    """Screenshots side by side with captions underneath. items = [(file, caption), ...]"""
    t = doc.add_table(rows=2, cols=len(items))
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    for i, (name, caption) in enumerate(items):
        c = t.rows[0].cells[i]
        p = c.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(2)
        p.paragraph_format.keep_with_next = True
        p.add_run().add_picture(os.path.join(SCREENS, name + ".jpg"), width=Inches(width))
        cp = t.rows[1].cells[i].paragraphs[0]
        cp.style = doc.styles["Caption"]
        cp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        cp.add_run(caption)
    for row in t.rows:                      # keep picture and caption on one page
        tr_pr = row._tr.get_or_add_trPr()
        cant = OxmlElement("w:cantSplit")
        cant.set(qn("w:val"), "true")
        tr_pr.append(cant)


def page_break():
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


def add_field(paragraph, instr):
    run = paragraph.add_run()
    for kind, text in (("begin", None), (None, instr), ("end", None)):
        if kind:
            el = OxmlElement("w:fldChar")
            el.set(qn("w:fldCharType"), kind)
        else:
            el = OxmlElement("w:instrText")
            el.set(qn("xml:space"), "preserve")
            el.text = text
        run._r.append(el)
    return run



# footer: title on the left, page number on the right
fp = sec.footer.paragraphs[0]
fp.paragraph_format.tab_stops.add_tab_stop(Inches(6.5), alignment=2)
r = fp.add_run("Wx Now – User's Manual\tPage ")
r.font.size = Pt(9)
r.font.color.rgb = GREY
add_field(fp, "PAGE").font.size = Pt(9)

# ── title page ───────────────────────────────────────────────────────────────
doc.add_paragraph()
doc.add_paragraph("Wx Now", style="Title")
doc.add_paragraph("User’s Manual for iPhone and Android", style="Subtitle")
para(f"Manual dated {date.today().strftime('%B %d, %Y').replace(' 0', ' ')}", color=GREY)
para("")
para("Wx Now tells you what the weather is about to do where you are. It watches the weather radar and "
     "tells you, to the minute, when rain will start and stop in the next hour. It also gives the next 24 hours "
     "and 7 days, what the weather will do to people outdoors, hurricanes and tropical storms, and marine "
     "conditions for boaters: the marine forecast, tides, water temperature and sailing weather maps. It can "
     "send you alerts for rain, storms, floods and more even when the app is closed.")
para("The app address is:")
para(ADDRESS, align=WD_ALIGN_PARAGRAPH.CENTER).runs[0].bold = True
para("")
note("Wx Now is not an official forecast. Forecasts can be wrong and alerts can be late or missed. For "
     "warnings and safety decisions, follow the National Weather Service, the National Hurricane Center and "
     "your local officials.", lead="Important: ")
h3("In this manual")
for line in [
    "1.  Installing Wx Now",
    "2.  Finding your way around",
    "3.  Local weather",
    "4.  Effects on people",
    "5.  Hurricanes",
    "6.  Seas & swell",
    "7.  Saved places",
    "8.  Settings",
    "9.  Alerts when the app is closed",
    "10. Troubleshooting",
    "11. Your data, updates and where the data comes from",
]:
    para(line, after=1).paragraph_format.left_indent = Inches(0.25)
page_break()

# ── 1 ────────────────────────────────────────────────────────────────────────
h1("1.  Installing Wx Now")
para("Wx Now is a web app. It does not come from the App Store or Google Play. You open its web page once, "
     "add it to your Home Screen, and from then on it opens like any other app. The step-by-step instructions, "
     "for iPhone and for Android, are in the separate sheet “How to add Wx Now to a Cellphone” that comes "
     "with this manual. In short:")
h2("iPhone or iPad")
steps([
    ("Open Safari ", "and go to  " + ADDRESS + "  (use Safari: alerts only work for an app added from Safari)."),
    ("Tap the Share button ", "(the square with an arrow pointing up), then “Add to Home Screen”, then “Add”."),
    ("Always open Wx Now from its Home Screen icon, ", "not from Safari. Alerts work only from the icon."),
])
h2("Android phone")
steps([
    ("Open Chrome ", "and go to  " + ADDRESS),
    ("Tap the menu ", "(three dots, top right), then “Add to Home screen” or “Install app”, then “Install”."),
    ("Open Wx Now from its icon.", ""),
])
h2("The first time you open it")
steps([
    ("Read the disclaimer ", "and tap “I understand and accept”. It is asked only once."),
    ("Allow Location ", "when the phone asks. The rain forecast is for your exact spot, so choose “Precise” "
     "if the phone offers it. Without location you can still tap the map to choose a place."),
    ("Turn on alerts ", "if you want them (section 9)."),
])
note("Wx Now needs an internet connection to fetch the radar and forecasts. With no signal it still opens and "
     "shows the last screens it had, and this manual opens too.", lead="Good to know: ")

# ── 2 ────────────────────────────────────────────────────────────────────────
h1("2.  Finding your way around")
screens([("local-top", "The Local weather tab: the next hour of rain, with the place bar above it."),
         ("settings", "Settings opens from the gear at the top right.")])
bullets([
    ("The four tabs ", "across the top: Local weather, Effects on people, Hurricanes, and Seas & swell. The app "
     "remembers which one you used last."),
    ("The place bar ", "under the tabs: “My location” (where the phone is), each of your saved places, and "
     "“Map point” when you have tapped the map. Tap one to show its weather. The ＋ button saves the spot you "
     "are looking at (section 7)."),
    ("↻ (top right) ", "fetches everything again. The app also updates by itself every few minutes."),
    ("⚙ (top right) ", "opens Settings: units, alerts, saved places and the disclaimer. Tap it again to close."),
    ("The slider on the right edge ", "scrolls the page. Drag the grey handle up or down, or tap anywhere on the "
     "track to jump there. It is wide so it is easy to grab with a thumb."),
    ("Tap the map ", "on the Local weather tab to see the forecast for any other spot. “Back to my location” "
     "under the map returns to where you are."),
])

# ── 3 ────────────────────────────────────────────────────────────────────────
h1("3.  Local weather")
para("This tab is the heart of the app: will it rain here, and when?")
h2("The next hour")
bullets([
    ("The headline ", "says what will happen in plain words, for example “Light rain starting in about 9 min "
     "(likely 3:01–3:09 PM)”, or “No rain for the next hour”. When it is already raining it says when it "
     "should stop."),
    ("The chips under it ", "show what is falling (rain, snow, a rain-and-snow mix, sleet or freezing rain), "
     "the visibility, and the air quality (AQI). Tap the AQI chip to go to the full air quality card on the "
     "Effects on people tab."),
    ("The chart ", "shows the chance of rain for each of the next 60 minutes. The colour shows how hard it would "
     "rain: light blue light, dark blue moderate, yellow heavy (white to purple for snow, pink for ice). The "
     "dashed line is 50%: where the curve crosses it is when the headline says rain starts or stops. The orange "
     "shaded bands show how early or late that could be."),
    ("The line under the chart ", "says where the forecast came from: the radar (and which radar site and how "
     "far away), or the weather model when you are offshore or too far from a radar."),
])
h2("The map and radar")
screens([("local-map", "The radar map. Arrows show which way the rain is moving."),
         ("local-hourly", "The next 24 hours, hour by hour.")])
bullets([
    ("The radar plays by itself, ", "the last 30 minutes then the forecast for the next hour, and updates every "
     "5 minutes. ▶ / ❚❚ plays or pauses it (remembered); the slider under the map picks one picture."),
    ("White arrows ", "show how the rain is moving. Teal arrows are the wind measured by each radar, 10,000 to "
     "20,000 ft up. The dashed line points to where your next hour of weather is coming from."),
    ("V ", "shows the Doppler velocity from the nearest radar: red is moving away from the radar, green toward "
     "it. Bright red right next to bright green means strong rotation or a sharp wind shift."),
    ("➤ ", "turns the storm-motion arrows on and off. “Show radar” hides or shows the radar pictures."),
    ("Outside the U.S. ", "the map shows a worldwide radar picture (RainViewer) for the last 2 hours; the "
     "forecast then comes from the weather model."),
])
h2("Next 24 hours and 7 days")
screens([("local-daily", "The 7-day forecast and the second opinion.")], width=2.6)
bullets([
    ("Next 24 hours: ", "each hour’s weather, temperature, chance of rain (when 10% or more) and wind, with an "
     "arrow pointing the way the wind blows."),
    ("Air quality ", "has moved to the Effects on people tab (section 4)."),
    ("7 days: ", "each day’s weather, low and high temperature (the bar shows where they fall in the week), chance "
     "of rain, wind and gusts, and the rain total."),
    ("Second opinion: NOAA vs Navy. ", "The U.S. (NOAA GFS) and Navy (NAVGEM) weather models side by side for each "
     "day. When they disagree a lot about a day, it is marked: trust that day less. “History” shows how close "
     "each model’s day-ahead forecast came over the last week, measured at the nearest airport."),
    ("The details list ", "at the bottom: temperature, feels-like, humidity, wind, visibility, storm-surge risk "
     "during a hurricane, the local time at the place, and when it was last updated."),
])

# ── 4 ────────────────────────────────────────────────────────────────────────
h1("4.  Effects on people")
para("This tab says what the weather will do to you, and to the people you look after, when you are outdoors: "
     "heat, cold, sun, humidity, wind, storms, the night ahead, the air, pollen, and the water if you fall in. "
     "It uses the same forecast as the Local weather tab, for the place picked in the place bar.")
screens([("people-top", "The 7 days, with today opened."),
         ("people-hot", "A hot, stormy day opened (Darwin, Australia).")])
h2("Right now")
para("The first line gives how the air feels now, the heat stress in the sun when it is warm, the UV index and "
     "the humidity.")
h2("The 7 days")
para("Each day has one line: the day, its weather, the range of feels-like temperatures, a coloured risk label, "
     "and short tags for what matters that day (for example “Danger · UV 9 · Lightning likely · Warm night”). "
     "Tap a day to open it; today is open to start with. Tap it again to close it.")
h3("The risk label")
table(["Label", "Colour", "What it means"], [
    ["Low risk", "Green", "Comfortable for most people outdoors. Moderate UV or a breeze alone stay green."],
    ["Take care", "Yellow", "Something needs a little thought: warm or cold enough to tire you (heat-index "
     "Caution, or feels below freezing), high UV, strong gusts, thunderstorms possible, a bitter-cold night, or "
     "a night too warm to sleep well without A/C."],
    ["High risk", "Orange", "Heat cramps or exhaustion possible with long exposure, very cold (feels like 0 °F "
     "or below), very high UV, damaging gusts, thunderstorms likely, or a night with no relief from the heat."],
    ["Dangerous", "Red", "Heat illness likely, frostbite within 30 minutes, extreme UV, or violent wind. "
     "Change your plans."],
    ["Extreme", "Purple", "Extreme heat or cold: heat stroke very likely, or frostbite within 10 minutes. Stay "
     "indoors if you can."],
], [1.1, 0.8, 4.6])
para("The label is the highest of all the day’s risks. Open the day to see which one set it.")
h3("What each line in a day means")
table(["Line", "What it tells you"], [
    ["Feels like", "The lowest and highest the air will feel on your skin in the shade: the National Weather "
     "Service wind chill when it is cold and windy, the heat index when it is hot and humid, otherwise the "
     "temperature. Heat-index words: Caution (80–90 °F), Extreme caution (90–103 °F), Danger (103–125 °F), "
     "Extreme danger (125 °F and up)."],
    ["Heat stress (WBGT)", "Shown on warm days. The Wet Bulb Globe Temperature for someone in the open, in "
     "the sun by day, the measure the military and sports bodies use to limit work. Under 80 °F low; 80–85 °F "
     "caution; 85–88 °F high; 88 °F and up extreme. It is an estimate from the forecast, not a measurement."],
    ["Frostbite", "Shown when it is cold enough: about how many minutes until bare skin can freeze (Environment "
     "Canada’s method). Shown only when it is 30 minutes or less."],
    ["UV index", "The day’s highest UV, from low (0–2) through moderate (3–5), high (6–7), very high (8–10) "
     "to extreme (11+), and about how long until a first sunburn on unprotected fair skin and on medium skin."],
    ["Humidity", "The day’s highest dew point and how sticky it feels: dry, comfortable, sticky, muggy, "
     "oppressive or miserable (see “What the weather does to you” below)."],
    ["Lightning", "Unlikely, thunderstorms possible, or thunderstorms likely, from the forecast’s "
     "thunderstorm hours and chance of rain. When the air holds a lot of storm energy (CAPE of 1,000 J/kg or "
     "more) the number is shown: the higher it is, the stronger storms can get."],
    ["Tonight", "How the night after that day (8 pm to 7 am) will be for sleeping: the low, and whether it is "
     "comfortable, a warm sticky night, too warm to sleep well without A/C, no relief from the heat, a freezing "
     "night or a bitter-cold night."],
    ["Dehydration", "Low, moderate or high: how fast you will lose water, from the heat, very dry air, or cold "
     "dry wind. The advice says how much to drink."],
    ["Sunshine", "Hours of sunshine out of the hours of daylight, and the average cloud cover in the day."],
    ["Wind", "The strongest wind and gusts, and Breezy (gusts 25 mph and up), Strong (40), Damaging (58) or "
     "Violent (75)."],
], [1.5, 5.0])
h3("The advice")
screens([("people-hot-advice", "The advice for that day.")], width=2.6)
para("Under the lines is plain advice for that day: when to do outdoor work, how much water to drink, how long "
     "before you burn and what to wear, what to do about lightning, how to cover up against frostbite, how to "
     "get through a hot night, and so on. A comfortable day just says so.")

h2("Air quality")
screens([("people-air", "Air quality, and the pollen note in the U.S."),
         ("people-water", "Cold water: Boston Harbor in late November.")])
bullets([
    ("The number ", "is the U.S. Air Quality Index (AQI) and its colour: Good (green, 0–50), Moderate (yellow), "
     "Unhealthy for sensitive groups (orange), Unhealthy (red), Very unhealthy (purple), Hazardous (maroon). "
     "It also says which pollutant is the main one: fine particles (smoke, haze), coarse particles (dust), "
     "ozone (smog) or Saharan dust."),
    ("The bars ", "are the next 24 hours, one bar an hour, and the line above them says when it gets better or "
     "worse."),
    ("The advice ", "says what to do at that level, especially for people with asthma, heart or lung disease, "
     "children and older adults."),
    ("Where it comes from: ", "in the U.S. “now” is measured at the nearest EPA monitor within about 30 miles "
     "(the line at the bottom names it); the next 24 hours are a forecast. Outside the U.S., or with no monitor "
     "nearby, it is the forecast alone, which can be off by a category."),
])
h2("Pollen")
para("Pollen for the next 4 days, by kind (alder, birch and olive trees, grass, mugwort and ragweed), rated "
     "None, Low, Moderate, High or Very high. On high days keep windows closed, take allergy medicine before "
     "going out, and shower after time outdoors.")
note("The free pollen forecast Wx Now uses covers Europe only. In the U.S. and everywhere else outside Europe "
     "the card says “Pollen isn’t available for this location.” That is expected, not a fault. In Europe out "
     "of season it says there is little or no pollen in the air.", lead="Pollen in the U.S.: ")
h2("Cold water: if you fall in")
para("For boaters, paddlers, fishermen and swimmers. It gives the sea temperature at the place and what "
     "happens to someone who falls in:")
bullets([
    ("The label: ", "Warm water (70 °F and up), Cool water (60–69 °F), Cold water (50–59 °F) or Very cold water "
     "(under 50 °F). Below 60 °F cold shock is a real danger."),
    ("Exhaustion or unconsciousness, and expected survival: ", "the U.S. Coast Guard’s times for an adult in "
     "ordinary clothes at that water temperature. A life jacket, wetsuit or dry suit makes them much longer; thin "
     "people and children cool faster."),
    ("Cold shock and 1-10-1 ", "(below 60 °F): 1 minute to get your breathing under control, about 10 minutes of "
     "useful movement to get out or hold on to something, about 1 hour before hypothermia knocks you out. Wear "
     "your life jacket and stay with the boat."),
    ("The table ", "gives the water temperature and survival time for each of the 7 days."),
])
para("When the place is inland, or on a lake, river or bay the ocean model does not cover, the card says there is "
     "no sea temperature for that spot. Choose a spot on open water, or look at the nearest buoy on the Seas & "
     "swell tab.")
h2("What the weather does to you")
screens([("people-guide", "The guide at the bottom of the tab, with Heat opened.")], width=2.6)
para("The last card explains, in a few lines each, what cold, heat, humidity, wind, sunshine and UV, cloud cover, "
     "dew point, lightning, warm and cold nights, cold water, and air quality and pollen do to the body, and how "
     "to protect yourself. Tap a heading to open it.")
note("These are general estimates for healthy adults from the forecast. Babies, older people, pregnant women, "
     "people with heart, lung or kidney disease and people on some medicines are affected sooner. If someone "
     "shows signs of heat stroke or hypothermia, call 911.", lead="Remember: ")

# ── 5 ────────────────────────────────────────────────────────────────────────
h1("5.  Hurricanes")
screens([("storms", "The Hurricanes tab: active storms and the tropical outlook."),
         ("storms-map", "The map: forecast cone, track and areas to watch.")])
bullets([
    ("Tropical storms: ", "every active Atlantic tropical storm and hurricane from the National Hurricane Center, "
     "with its strength, how far it is from your place and its closest forecast approach, and whether a cone, watch or warning covers your place. Tick “on map” to draw them on the map. "
     "When there are none it says so."),
    ("Tropical weather outlook: ", "the National Hurricane Center’s areas to watch, with the chance each will "
     "become a tropical storm in the next 2 and 7 days, and the outlook text."),
    ("The map: ", "the forecast cone (white), the track with points coloured by strength, the wind field, and "
     "coastal watches and warnings. Tap a point for its details."),
    ("Storm surge: ", "pick “If a Category 1 … 5 hurricane hits” to see the National Hurricane Center’s "
     "planning maps of how deep the water could get, or the live surge forecast when a storm is coming. On the "
     "Local weather tab the details list then shows the surge risk at your place."),
])
para("Follow National Hurricane Center advisories and your local officials for decisions to stay or leave.")

# ── 6 ────────────────────────────────────────────────────────────────────────
h1("6.  Seas & swell")
para("Marine conditions for the Gulf and Atlantic coasts, the Bahamas, the Caribbean and Bermuda.")
screens([("seas-marine", "The marine forecast for the nearest zone."),
         ("seas-tides", "Tides at the nearest station.")])
bullets([
    ("Marine forecast: ", "the National Weather Service forecast for the marine zone you are in or nearest "
     "(pick another from the list), with any advisories and warnings in force (Small Craft Advisory, Gale, "
     "Storm, Special Marine Warning, Dense Fog). “Show zone on map” draws the zone."),
    ("Tides: ", "the nearest NOAA tide station (pick another from the list): the tide now and whether it is "
     "rising or falling, a curve for the next 3 days, and the high and low times. Where a NOAA gauge measures "
     "the water, it also says whether the water is running above or below the predicted tide."),
    ("Water temperature: ", "the sea temperature at the spot for the next 5 days, and what the nearest NOAA buoys "
     "and coastal stations measure now (water temperature, waves and wind)."),
    ("Water clarity (testing): ", "how far down you could see, from satellites. Readings are from the last clear "
     "pass, not live, and are not a measure of water quality."),
])
screens([("seas-water", "Water temperature: the model and nearby buoys."),
         ("seas-passage", "Sailing weather maps.")])
bullets([
    ("Sailing weather: ", "forecast maps for a region you pick: wind (barbs, in knots), waves, pressure and rain, "
     "visibility (fog), sea temperature, and water levels measured now. Choose NOAA (7 days) or the Navy "
     "(5 days) model, then play the forecast with ▶ or drag the slider. Tap the map for the wind, waves, "
     "pressure, rain and visibility at that spot."),
    ("Navy waves ", "on the main map: the Navy’s wave forecast, coloured by height with arrows for the way the "
     "waves travel. It comes on by itself the first time you open this tab; turn it off with the list above "
     "the map."),
])

# ── 7 ────────────────────────────────────────────────────────────────────────
h1("7.  Saved places")
screens([("settings-places", "Saved places in Settings, with the User’s manual button below.")], width=2.6)
para("Save the places you care about, such as Home, the marina or a family member’s house, to switch between "
     "them with one tap and to get alerts for them when the app is closed.")
steps([
    ("Show the place: ", "use My location, or tap the map on the Local weather tab where you want it."),
    ("Tap ＋ in the place bar. ", "Settings opens at “Saved places”."),
    ("Type a name ", "(for example Home or Marina) and tap “Save this spot”."),
])
para("The place then appears in the place bar on every tab. To remove one, open Settings › Saved places and tap "
     "“Remove” next to it.")

# ── 8 ────────────────────────────────────────────────────────────────────────
h1("8.  Settings")
para("Tap ⚙ at the top right. Settings opens above the tabs; tap ⚙ again to close it.")
bullets([
    ("Units: ", "US (inches per hour, mph, °F) or Metric (mm per hour, km/h, °C)."),
    ("Alerts when the app is closed: ", "turn them on and choose which alerts you want (section 9)."),
    ("Saved places: ", "section 7."),
    ("While the app is open: ", "“Alert me when rain is within 15 minutes” buzzes and notifies while the app is "
     "open. You don’t need it when closed-app alerts are on."),
    ("Water clarity: Sentinel-2 (testing): ", "optional. Only for people with a free Copernicus account; most "
     "people can leave it empty."),
    ("Advanced: ", "the alert server address. Leave it as it is."),
    ("User’s manual: ", "opens this manual (it works with no signal too)."),
    ("Disclaimer: ", "read the disclaimer again."),
])

# ── 9 ────────────────────────────────────────────────────────────────────────
h1("9.  Alerts when the app is closed")
screens([("settings", "Turning alerts on."), ("settings-alerts", "Choosing which alerts you get.")])
para("Wx Now can send a notification about 15 minutes before rain, and other weather alerts, at your saved "
     "places and wherever you last opened the app, even when the app is closed.")
steps([
    ("Open Wx Now from its Home Screen icon ", "(on iPhone, alerts can only be turned on from the icon, with "
     "iOS 16.4 or later)."),
    ("Tap ⚙, ", "then under “Alerts when the app is closed” tap “Turn on”."),
    ("Allow notifications ", "when the phone asks. The label changes to “On”."),
    ("Tap “Send test alert”. ", "A notification should arrive within a few seconds."),
    ("Choose the other alerts ", "you want from the lists below it (see the table)."),
])
table(["Alert", "What you get"], [
    ["Rain", "About 15 minutes before rain at each place; one alert per rain event, not repeated reminders."],
    ["Hurricanes", "When a place comes into a storm’s forecast cone, when a watch or warning covers its coast "
     "(and again if upgraded), and when tropical-storm or hurricane-force winds arrive. Comes with rain alerts."],
    ["High water", "When the water at the nearest NOAA gauge runs a set height above the predicted tide."],
    ["Flash flood", "Warnings at or near your places, and optionally watches, radar rain at flash-flood levels, "
     "and the daily outlook."],
    ["Tornado", "Warnings covering or near your places (with which way the storm is moving), and optionally "
     "watches and the daily outlook."],
    ["Hail", "Hail of your chosen size seen on radar within 10 miles, warnings with hail, and the daily outlook."],
    ["Rip current", "High (or moderate) rip current risk at the beach, and high-surf alerts."],
    ["Lightning", "Lightning detected by satellite within your chosen distance, “very close”, and an all clear "
     "after 30 minutes; severe thunderstorm watches and warnings."],
    ["Fog", "Visibility forecast to drop to your chosen distance in the next 12 hours, and fog advisories."],
    ["Extreme tide", "A high tide well above normal (such as king tides) or a low tide well below normal, up "
     "to 2 days ahead."],
    ["Wind forecast", "Sustained wind forecast to reach your chosen speed in the next 24 hours."],
    ["Water temperature", "The water at the nearest buoy warming or cooling by your chosen amount."],
    ["Tropical outlook", "A new area the Hurricane Center is watching, or its chances going up (tick box)."],
    ["Marine", "Small Craft Advisory, Gale, Storm and Special Marine Warnings and Dense Fog Advisories for your "
     "marine zones (tick box)."],
], [1.5, 5.0])
para("Tapping an alert opens the tab it is about. The full details of every alert, with examples, are in “How to "
     "add Wx Now to a Cellphone”.")
note("Alerts depend on the phone, the network and the alert server, and can be late or missed. Never rely on "
     "them alone for your safety: keep a NOAA weather radio or your phone’s emergency alerts on too.",
     lead="Important: ")

# ── 10 ───────────────────────────────────────────────────────────────────────
h1("10.  Troubleshooting")
table(["Problem", "What to do"], [
    ["“Waiting for your location…”", "Allow Location for Wx Now (iPhone: Settings › Privacy & Security › "
     "Location Services › Safari Websites; Android: Settings › Apps › Chrome › Permissions › Location), or "
     "tap the map to choose a spot."],
    ["The rain time was wrong", "The forecast is best for rain already on the radar and moving steadily. Storms "
     "that pop up from nothing, especially on summer afternoons, can’t be seen in advance. The orange bands on "
     "the chart show how early or late it could be."],
    ["No alerts arrive", "Open the app from the Home Screen icon, check Settings shows alerts “On”, tap “Send "
     "test alert”, and check the phone’s notification settings for Wx Now (and Focus or Do Not Disturb)."],
    ["Pollen says it isn’t available", "Normal outside Europe; the free pollen forecast covers Europe only."],
    ["Cold water says there is no sea temperature", "The place is inland or on water the ocean model doesn’t "
     "cover. Tap the map on open water, or use the buoys on Seas & swell."],
    ["A card says “unavailable”", "That data service did not answer. Tap ↻ to try again, or wait a few minutes."],
    ["Saved places or settings are missing", "On an iPhone, the Home Screen icon and Safari keep separate data. "
     "Open the app the same way you did when you saved them."],
], [2.2, 4.3])

# ── 11 ───────────────────────────────────────────────────────────────────────
h1("11.  Your data, updates and where the data comes from")
bullets([
    ("Your data stays on your phone. ", "Settings and saved places are stored only on the phone. With alerts "
     "on, your saved places, last location and alert choices are sent to the Wx Now alert server so it can check "
     "the weather there; nothing else about you is sent."),
    ("Updates: ", "there is nothing to download. When you open the app with an internet connection it picks up "
     "any new version by itself; close it and open it again to use it."),
    ("To remove it: ", "on iPhone press and hold the icon, tap “Remove App”, then “Delete App”; on Android press "
     "and hold the icon, then tap “Uninstall”. This also deletes saved places and settings."),
])
para("Where the data comes from:")
bullets([
    ("Radar: ", "NOAA NEXRAD through the Iowa Environmental Mesonet; RainViewer outside the U.S."),
    ("Forecasts: ", "Open-Meteo (NOAA HRRR and GFS and other national models), the Navy NAVGEM model, and the "
     "National Weather Service."),
    ("Effects on people: ", "worked out in the app from the Open-Meteo forecast, with National Weather Service "
     "heat index and wind chill, an estimated WBGT, Environment Canada frostbite times, and U.S. Coast Guard "
     "cold-water survival times."),
    ("Air quality and pollen: ", "EPA AirNow monitors and the Copernicus CAMS forecast through Open-Meteo."),
    ("Hurricanes: ", "the National Hurricane Center."),
    ("Marine, tides and water: ", "the National Weather Service, NOAA tides and currents, NOAA buoys, the Navy "
     "WAVEWATCH III wave model and satellites."),
    ("Map: ", "Esri."),
])
para("The full disclaimer is shown the first time the app is opened and can be read again from Settings.")

doc.core_properties.title = "Wx Now – User’s Manual"
doc.core_properties.author = ""
doc.save(OUT)
print("wrote", OUT)

if os.path.exists(SOFFICE):
    for fmt in ("doc:MS Word 97", "pdf"):
        subprocess.run([SOFFICE, "--headless", "--convert-to", fmt, "--outdir", ROOT, OUT],
                       check=True, capture_output=True, timeout=180)
        print("wrote", os.path.splitext(OUT)[0] + "." + fmt.split(":")[0])
