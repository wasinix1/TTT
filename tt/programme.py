"""An event's text, read for its structure.

The organiser writes one text, the way they would write it for a group chat,
and its layout comes from what the lines look like — so next month's event
needs no setup of its own (docs/events-and-registration.md has the rules).
This is the only place that reads it: the site, the Telegram message and the
console's preview all draw from `parse`, so they cannot disagree.

Every string in a parsed document is already safe HTML: escaped, with `<b>`
the only tag that can appear. `*` is the only markup.
"""

import html
import re
import textwrap

LIMIT = 3000            # leaves room in Telegram's 4096 for the card around it
LABEL_MAX = 40

esc = lambda s: html.escape(str(s), quote=False)

_DASH = r"\s*[-–—]\s*"
_TIME_ROW = re.compile(
    # a dotted time only counts as half of a range: "13.11 Anmeldung" is a date
    rf"^(?:(\d{{1,2}}:\d{{2}})|(\d{{1,2}}\.\d{{2}})(?={_DASH}))"
    rf"(?:{_DASH}(\d{{1,2}}[:.]\d{{2}}))?\s+(\S.*)$")
_BOLD_LINE = re.compile(r"^\*(\S(?:[^*]*\S)?)\*$")
# not inside a word, so "2*3 und 4*5" stays as typed
_BOLD = re.compile(r"(?<![\w*])\*(\S(?:[^*\n]*\S)?)\*(?![\w*])")
_CHIP = re.compile(r"^(.*\S)\s*\(([^()]+)\)$")
_DATE = re.compile(r"(?<![\d.])(\d{1,2})\.(\d{1,2})\.")


def check(text):
    if len(text or "") > LIMIT:
        raise ValueError(f"that event text is too long — {LIMIT} characters at most")


def _plain(s):
    return _BOLD.sub(r"\1", s)


def _inline(s):
    return _BOLD.sub(r"<b>\1</b>", esc(s))


def _kind(line):
    if not line:
        return "blank"
    bold = _BOLD_LINE.match(line)
    if bold:
        return "label" if bold.group(1).endswith(":") else "head"
    if _TIME_ROW.match(line):
        return "time"
    if line.endswith(":") and len(line) <= LABEL_MAX:
        return "label"
    return "text"


def _lines(text):
    return [x.strip() for x in (text or "").replace("\r\n", "\n").split("\n")]


def _title_at(lines):
    """Where the title is, or None. A bold first line set apart from plain
    text; one with its text right under it is already the first section."""
    i = next((n for n, x in enumerate(lines) if x), None)
    if i is None or _kind(lines[i]) != "head":
        return None
    if i + 1 >= len(lines) or lines[i + 1]:
        return None
    after = next((x for x in lines[i + 1:] if x), "")
    return i if _kind(after) == "text" else None


def parse(text):
    """{title, lead: [block], sections: [{heading, chip, timetable, blocks}]}

    A block is {t: text, lines}, {t: label, text} or {t: times, rows}."""
    lines = _lines(text)
    doc = {"title": "", "lead": [], "sections": []}
    at = _title_at(lines)
    if at is not None:
        doc["title"] = esc(_plain(lines[at].strip("*")))
    blocks, para = doc["lead"], None
    for n, line in enumerate(lines):
        if n == at:
            continue
        kind = _kind(line)
        if kind == "text":
            if para is None:
                para = {"t": "text", "lines": []}
                blocks.append(para)
            para["lines"].append(_inline(line))
            continue
        para = None
        if kind == "head":
            name = line[1:-1].strip()
            chip = _CHIP.match(name)
            sec = {"heading": esc(_plain(chip.group(1) if chip else name)),
                   "chip": esc(_plain(chip.group(2))) if chip else "",
                   "timetable": False, "blocks": []}
            doc["sections"].append(sec)
            blocks = sec["blocks"]
        elif kind == "label":
            blocks.append({"t": "label",
                           "text": esc(_plain(line.strip("*")).rstrip(":").strip())})
        elif kind == "time":
            a, dotted, b, what = _TIME_ROW.match(line).groups()
            when = (a or dotted).replace(".", ":")
            if b:
                when += "–" + b.replace(".", ":")
            if not blocks or blocks[-1]["t"] != "times":
                blocks.append({"t": "times", "rows": []})
            blocks[-1]["rows"].append({"time": esc(when), "text": _inline(what)})
    for sec in doc["sections"]:
        sec["timetable"] = bool(sec["blocks"]) and all(b["t"] == "times" for b in sec["blocks"])
    return doc


def parts(doc):
    """What was understood, for the row of chips under the editor."""
    normal = [s for s in doc["sections"] if not s["timetable"]]
    rows = sum(len(b["rows"]) for s in doc["sections"] if s["timetable"] for b in s["blocks"])
    out = []
    if doc["title"]:
        out.append("Title")
    if doc["lead"]:
        out.append("Lead")
    if normal:
        out.append(f"{len(normal)} section{'' if len(normal) == 1 else 's'}")
    if rows:
        out.append(f"Timetable, {rows} row{'' if rows == 1 else 's'}")
    return out


def teaser(text, limit=200):
    """One plain line for where a long text cannot go: link cards, the poster."""
    para = []
    for line in _lines(text):
        if _kind(line) == "text":
            para.append(_plain(line))
        elif para:
            break
    return textwrap.shorten(" ".join(para), width=limit, placeholder=" …")


def date_mismatch(text, starts_at):
    """A text carried over from last time still saying last time's date. Only
    when the event's own date appears nowhere: a sign-up deadline is fine."""
    m = re.match(r"\d{4}-(\d{2})-(\d{2})", starts_at or "")
    if not m:
        return None
    want = (int(m.group(2)), int(m.group(1)))
    found = [(int(d), int(mo)) for d, mo in _DATE.findall(text or "")
             if 1 <= int(d) <= 31 and 1 <= int(mo) <= 12]
    if not found or want in found:
        return None
    return {"says": "%d.%d." % found[0], "starts": "%d.%d." % want}


# ------------------------------------------------------------------- web

def _web_blocks(blocks):
    out = []
    for b in blocks:
        if b["t"] == "text":
            out.append(f'<p>{"<br>".join(b["lines"])}</p>')
        elif b["t"] == "label":
            out.append(f'<h4 class="pg-label">{b["text"]}</h4>')
        else:
            rows = "".join(f'<div><b>{r["time"]}</b><span>{r["text"]}</span></div>'
                           for r in b["rows"])
            out.append(f'<div class="pg-times">{rows}</div>')
    return "".join(out)


def _wide_tiles(sections):
    """Timetables take the whole row, so the tiles between them come in runs;
    an odd run's last tile stretches rather than leaving a hole beside it."""
    wide, run = set(), 0
    for n, sec in enumerate(sections):
        if sec["timetable"]:
            if run % 2:
                wide.add(n - 1)
            run = 0
        else:
            run += 1
    if run % 2:
        wide.add(len(sections) - 1)
    return wide


def web(doc):
    head = ""
    if doc["title"]:
        head += f'<h2 class="pg-title">{doc["title"]}</h2>'
    if doc["lead"]:
        head += f'<div class="pg-lead">{_web_blocks(doc["lead"])}</div>'
    tiles = ""
    wide = _wide_tiles(doc["sections"])
    for n, sec in enumerate(doc["sections"]):
        cls = "pg-tile" + (" dark" if sec["timetable"] else " wide" if n in wide else "")
        chip = f' <span class="pg-chip">{sec["chip"]}</span>' if sec["chip"] else ""
        tiles += (f'<section class="{cls}"><h3 class="pg-h">{sec["heading"]}{chip}</h3>'
                  f'{_web_blocks(sec["blocks"])}</section>')
    return ((f'<div class="pg-head">{head}</div>' if head else "")
            + (f'<div class="pg-grid">{tiles}</div>' if tiles else ""))


# -------------------------------------------------------------- telegram

def _tg_blocks(blocks):
    out = ""
    for n, b in enumerate(blocks):
        if n:
            out += "\n" if blocks[n - 1]["t"] == "label" else "\n\n"
        if b["t"] == "text":
            out += "\n".join(b["lines"])
        elif b["t"] == "label":
            out += f'<b>{b["text"]}</b>'
        else:
            out += "\n".join(f'<b>{r["time"]}</b>  {r["text"]}' for r in b["rows"])
    return out


def telegram(doc):
    """The lead in the open and the rest folded, so a long programme does not
    push the entry buttons off the screen. Telegram has no headings: bold,
    and the title gives way to the event's own name above it."""
    secs = []
    for sec in doc["sections"]:
        name = sec["heading"] + (f' ({sec["chip"]})' if sec["chip"] else "")
        body = _tg_blocks(sec["blocks"])
        secs.append(f"<b>{name}</b>" + (f"\n{body}" if body else ""))
    fold = ("<blockquote expandable>" + "\n\n".join(secs) + "</blockquote>") if secs else ""
    return "\n\n".join(x for x in (_tg_blocks(doc["lead"]), fold) if x)


def visible_length(message):
    """How Telegram counts a message: after the markup is gone."""
    return len(html.unescape(re.sub(r"<[^>]+>", "", message)))
