#!/usr/bin/env python3
"""Render a work-status brief model (JSON) into the styled HTML brief.

Usage:
    render.py brief.json --out ~/.claude/briefs/2026-08-17.html

The model is authored by the skill each morning; this script owns the
design so the layout cannot drift from one run to the next.

Model shape (all sections optional except date/headline):

{
  "date": "Monday · August 17 2026",
  "headline": "One sentence naming the shape of the day.",
  "arc": {
    "label": "Sprint 42 · day 6 of 10",
    "days": [ {"label": "Mon 11", "load": 3, "landed": 2}, ... ],
    "todayIndex": 5
  },
  "columns": [ {"label": "Landed", "body": "plain text"}, ... ],
  "sections": [
    {"title": "Needs attention",
     "items": [ {"title": "...", "href": "...", "bodyHtml": "..."} ]}
  ]
}

`bodyHtml` is emitted verbatim so items can carry inline <a class="src">
links; everything else is escaped.
"""

import argparse
import html
import json
import sys
from pathlib import Path

# Geometry lifted from the reference brief so the terrain keeps its shape.
VIEW_W, VIEW_H = 840, 170
Y_FLAT, Y_PEAK = 128, 72


def esc(s):
    return html.escape(s or "", quote=True)


# --------------------------------------------------------------------------
# The terrain drawing
# --------------------------------------------------------------------------


def sun_svg():
    """The same hand-drawn sun, fixed top-right."""
    rays = [
        (700, 17, 700, 24), (700, 64, 700, 71),
        (673, 44, 680, 44), (720, 44, 727, 44),
        (681, 25, 686, 30), (714, 58, 719, 63),
        (719, 25, 714, 30), (686, 58, 681, 63),
    ]
    lines = "".join(
        f'<line x1="{a}" y1="{b}" x2="{c}" y2="{d}"/>' for a, b, c, d in rays
    )
    return (
        '<g fill="none" stroke="#C6613F" stroke-width="2" stroke-linecap="round">'
        f'<circle cx="700" cy="44" r="15"/>{lines}</g>'
    )


def terrain_svg(arc):
    """Draw the sprint as terrain: height is load, dots are days work landed.

    Falls back to a flat line when there is no arc data, which still reads as
    a deliberate drawing rather than a broken one.
    """
    days = (arc or {}).get("days") or []
    if not days:
        path = f"M 0 {Y_FLAT} L {VIEW_W} {Y_FLAT}"
        return (
            f'<svg viewBox="0 0 {VIEW_W} {VIEW_H}" xmlns="http://www.w3.org/2000/svg" '
            'role="img" aria-label="A flat, quiet stretch of work.">'
            f"{sun_svg()}"
            f'<path d="{path}" fill="none" stroke="#2E2C27" stroke-width="2" '
            'stroke-linecap="round" stroke-linejoin="round"/></svg>'
        )

    loads = [max(0, d.get("load") or 0) for d in days]
    peak = max(loads) or 1
    n = len(days)
    # Inset so the endpoints do not collide with the viewBox edge.
    x_of = lambda i: round(20 + i * ((VIEW_W - 40) / max(1, n - 1)), 1)
    y_of = lambda v: round(Y_FLAT - (v / peak) * (Y_FLAT - Y_PEAK), 1)

    pts = [(x_of(i), y_of(v)) for i, v in enumerate(loads)]
    path = "M " + " L ".join(f"{x} {y}" for x, y in pts)

    dots = []
    for i, d in enumerate(days):
        landed = d.get("landed") or 0
        if landed <= 0:
            continue
        r = 8 if landed == 1 else (10 if landed == 2 else 11)
        x, y = pts[i]
        dots.append(f'<circle cx="{x}" cy="{y}" r="{r}" fill="#2E2C27"/>')

    today = (arc or {}).get("todayIndex")
    marker = ""
    if isinstance(today, int) and 0 <= today < n:
        x, y = pts[today]
        marker = (
            f'<line x1="{x}" y1="{y + 6}" x2="{x}" y2="{Y_FLAT + 26}" '
            'stroke="#C6613F" stroke-width="2" stroke-linecap="round" '
            'stroke-dasharray="1 5"/>'
        )

    labels = []
    for i, d in enumerate(days):
        text = d.get("label")
        if not text:
            continue
        x = pts[i][0]
        anchor = "start" if i == 0 else ("end" if i == n - 1 else "middle")
        labels.append(
            f'<text x="{x}" y="{Y_FLAT + 42}" text-anchor="{anchor}" '
            'font-family="-apple-system, Segoe UI, sans-serif" font-size="11" '
            f'fill="#B4B3A8">{esc(text)}</text>'
        )

    desc = (arc or {}).get("label") or "The sprint drawn as terrain."
    return (
        f'<svg viewBox="0 0 {VIEW_W} {VIEW_H}" xmlns="http://www.w3.org/2000/svg" '
        f'role="img" aria-label="{esc(desc)}">'
        f"{sun_svg()}{marker}"
        f'<path d="{path}" fill="none" stroke="#2E2C27" stroke-width="2" '
        'stroke-linecap="round" stroke-linejoin="round"/>'
        f'{"".join(dots)}{"".join(labels)}</svg>'
    )


# --------------------------------------------------------------------------


def render_columns(columns):
    if not columns:
        return ""
    out = ['<div class="acts">']
    for c in columns:
        out.append(
            '<div class="act">'
            f'<p class="time">{esc(c.get("label"))}</p>'
            f'<p>{esc(c.get("body"))}</p></div>'
        )
    out.append("</div>")
    return "".join(out)


def render_sections(sections):
    out = []
    for sec in sections or []:
        items = sec.get("items") or []
        if not items:
            continue
        out.append(f'<h2 class="section">{esc(sec.get("title"))}</h2>')
        out.append('<ol class="list">')
        for i, item in enumerate(items, 1):
            title = esc(item.get("title"))
            href = item.get("href")
            head = (
                f'<a class="title" href="{esc(href)}">{title}</a>'
                if href
                else f'<span class="title">{title}</span>'
            )
            body = item.get("bodyHtml") or esc(item.get("body"))
            out.append(
                "<li>"
                f'<span class="num">{i}</span>'
                f'<span class="body-col">{head}<p class="line">{body}</p></span>'
                "</li>"
            )
        out.append("</ol>")
    return "".join(out)


TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
:root {{
  --bg: #FCFCFB;
  --wash: #F9F9F7;
  --ink: #2E2C27;
  --ink-soft: #6B6A63;
  --ink-grey: #B4B3A8;
  --hairline: #E4E3DC;
  --edge: #E1E1DF;
  --clay: #C6613F;
}}
* {{ box-sizing: border-box; }}
html, body {{ margin: 0; padding: 0; }}
body {{
  background: var(--bg);
  color: var(--ink-soft);
  font-family: -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}}
.band-top {{ background: var(--wash); border-bottom: 1px solid var(--edge); }}
.band-bottom {{ background: var(--bg); }}
.inner {{ max-width: 860px; margin: 0 auto; padding: 56px 32px 44px; }}
.band-bottom .inner {{ padding-top: 48px; padding-bottom: 72px; }}

.daydate {{
  font-size: 13px;
  color: var(--ink-soft);
  letter-spacing: 0.02em;
  margin: 0 0 14px;
}}
.headline {{
  font-family: 'Fraunces', Georgia, 'Times New Roman', serif;
  font-weight: 600;
  font-size: 40px;
  line-height: 1.18;
  color: var(--ink);
  margin: 0 0 30px;
  max-width: 22em;
}}
.drawing {{ width: 100%; display: block; margin: 0 0 8px; }}
.drawing svg {{ width: 100%; height: auto; display: block; overflow: visible; }}

.acts {{ display: flex; margin-top: 18px; }}
.act {{ flex: 1 1 0; padding: 0 26px; }}
.act:first-child {{ padding-left: 0; }}
.act:last-child {{ padding-right: 0; }}
.act + .act {{ border-left: 1px solid var(--hairline); }}
.act .time {{
  font-weight: 700;
  font-size: 13px;
  color: var(--ink);
  margin: 0 0 7px;
  letter-spacing: 0.01em;
}}
.act p {{ margin: 0; font-size: 14px; line-height: 1.55; color: var(--ink-soft); }}

h2.section {{
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink);
  margin: 0 0 20px;
}}
.list {{ list-style: none; margin: 0 0 44px; padding: 0; counter-reset: item; }}
.list:last-child {{ margin-bottom: 0; }}
.list li {{
  display: flex;
  gap: 16px;
  padding: 0 0 22px;
}}
.list li:last-child {{ padding-bottom: 0; }}
.num {{
  flex: 0 0 auto;
  font-size: 13px;
  color: var(--ink-grey);
  padding-top: 2px;
  min-width: 14px;
  font-variant-numeric: tabular-nums;
}}
.body-col {{ flex: 1 1 auto; }}
.title {{
  display: block;
  font-size: 15px;
  font-weight: 700;
  color: var(--ink);
  text-decoration: none;
  margin: 0 0 5px;
  line-height: 1.35;
}}
a.title:hover {{ text-decoration: underline; }}
.line {{ margin: 0; font-size: 14px; line-height: 1.6; color: var(--ink-soft); }}
.src {{ color: var(--ink-soft); text-decoration: underline; }}
code {{
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.92em;
  color: var(--ink);
}}

@media (max-width: 640px) {{
  .inner {{ padding: 40px 20px 34px; }}
  .band-bottom .inner {{ padding-top: 36px; padding-bottom: 56px; }}
  .headline {{ font-size: 30px; }}
  .acts {{ display: block; }}
  .act {{ padding: 0; }}
  .act + .act {{
    border-left: 0;
    border-top: 1px solid var(--hairline);
    margin-top: 20px;
    padding-top: 20px;
  }}
}}
</style>
</head>
<body>

<div class="band-top">
  <div class="inner">
    <p class="daydate">{date}</p>
    <h1 class="headline">{headline}</h1>

    <div class="drawing">{drawing}</div>

    {columns}
  </div>
</div>

<div class="band-bottom">
  <div class="inner">
{sections}
  </div>
</div>

</body>
</html>
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model", help="path to the brief model JSON")
    ap.add_argument("--out", required=True, help="path to write the HTML to")
    args = ap.parse_args()

    model = json.loads(Path(args.model).expanduser().read_text())
    if not model.get("headline"):
        sys.exit("model is missing a headline")

    doc = TEMPLATE.format(
        title=esc(model.get("title") or "Work status"),
        date=esc(model.get("date")),
        headline=esc(model["headline"]),
        drawing=terrain_svg(model.get("arc")),
        columns=render_columns(model.get("columns")),
        sections=render_sections(model.get("sections")),
    )

    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(doc)
    print(out)


if __name__ == "__main__":
    main()
