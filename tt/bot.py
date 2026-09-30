"""The bot's side of the conversation: what a player reads and taps.

One card per player — the event, their entries, where they are tonight —
edited in place as they tap, and re-sent fresh when they ask for it. Every
action on it goes through the same ops the console uses, under the internal
`system` role, and only after checking it is theirs to do: a player speaks
for themselves and nobody else (docs/telegram.md, principle 5).

German, du-form, like the landing page and the wall.
"""

import html
import json
import re
import time
from datetime import datetime

from .models import decide_winner

esc = lambda s: html.escape(str(s if s is not None else ""), quote=False)


def button(text, data):
    return {"text": text, "callback_data": data[:64]}


# ------------------------------------------------------------------- words

_FIXED = {
    "Final": "Finale", "Semi-final": "Halbfinale", "Quarter-final": "Viertelfinale",
    "Third place": "Spiel um Platz 3", "Scramble doubles": "Zufallsdoppel",
    "Open play": "", "Swiss": "", "Manual": "", "Manual entry": "",
}
_PATTERNS = [
    (re.compile(r"^Group (.+)$"), r"Gruppe \1"),
    (re.compile(r"^Round of (\d+)$"), r"Runde der letzten \1"),
    (re.compile(r"^Round (\d+)$"), r"Runde \1"),
]


def label_de(label):
    """The console's match labels, as a player in the hall would say them."""
    label = (label or "").strip()
    if label in _FIXED:
        return _FIXED[label]
    for rx, sub in _PATTERNS:
        if rx.match(label):
            return rx.sub(sub, label)
    return label


def table_de(t):
    name = (t.name or "").strip()
    m = re.match(r"^Table\s+(\d+)$", name)
    if m or not name:
        return f"Tisch {m.group(1) if m else t.number}"
    return name


WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]
KIND_DE = {"open_play": "Offenes Spiel", "groups": "Gruppen und K.o.",
           "single_elim": "K.o.-Runde", "swiss": "Schweizer System"}


def when_line(store):
    ev = store.event
    raw = (ev.get("starts_at") or "").strip()
    bits = []
    try:
        d = datetime.fromisoformat(raw) if raw else None
    except ValueError:
        d = None
    if d:
        bits.append(f"{WEEKDAYS[d.weekday()]} {d.day:02d}.{d.month:02d}.")
        t = f"{d.hour}:{d.minute:02d}"
        end = re.match(r"^(\d{1,2}):(\d{2})", ev.get("ends_at") or "")
        bits.append(f"{t}–{int(end.group(1))}:{end.group(2)}" if end else t)
    venue = (ev.get("venue") or "").split(",")[0].strip()
    if venue:
        bits.append(venue)
    return " · ".join(esc(b) for b in bits)


def _day_word(start, now):
    a = datetime.fromtimestamp(start).date()
    b = datetime.fromtimestamp(now).date()
    diff = (a - b).days
    if diff == 0:
        return "Heute"
    if diff == 1:
        return "Morgen"
    return f"{WEEKDAYS[a.weekday()]} {a.day:02d}.{a.month:02d}."


def best_of(m):
    return f"Best of {m.scoring.best_of} bis {m.scoring.points_to}"


def _side_of(m, pid):
    return "a" if pid in m.side_a else "b"


def _mine(games, side):
    return [list(g) if side == "a" else [g[1], g[0]] for g in games]


def games_line(games):
    return " · ".join(f"{a}:{b}" for a, b in games)


def _opponents(app, m, pid):
    s = app.store
    side = _side_of(m, pid)
    other = "b" if side == "a" else "a"
    mates = [s.players[q].name for q in (m.side_a if side == "a" else m.side_b)
             if q != pid and q in s.players]
    return mates, app.side_name(m, other)


# ------------------------------------------------------------- notifications

def text_next(opp, eta, tables_label, label, cup_name):
    lines = ["⏳ <b>Gleich bist du dran</b>"]
    if opp:
        lines.append(f"gegen {esc(opp)}")
    where = [x for x in (cup_name, label) if x]
    if where:
        lines.append(esc(" · ".join(where)))
    soon = ("jeden Moment" if eta is not None and eta <= 0
            else f"etwa {eta} Min" if eta is not None else "")
    lines.append(" · ".join(x for x in (soon, esc(tables_label)) if x))
    return "\n".join(l for l in lines if l)


def text_go(app, m, pid, table, multi, scores):
    s = app.store
    mates, opp = _opponents(app, m, pid)
    cup = s.cups.get(s.cup_of_format(s.formats.get(m.format_id)) or "")
    where = [x for x in ((cup.name if cup and multi else ""), label_de(m.label)) if x]
    lines = [f"🏓 <b>Du bist dran — {esc(table_de(table))}</b>",
             (f"mit {esc(', '.join(mates))} " if mates else "") + f"gegen {esc(opp)}",
             esc(" · ".join(where + [best_of(m)]))]
    if scores:
        lines += ["", "<i>Nach dem Spiel einfach das Ergebnis hier eintippen, "
                      "z. B. 11:7 9:11 11:5</i>"]
    return "\n".join(lines)


def text_after(app, m, pid):
    """What a table call turns into once the match is off the table."""
    if not m or m.status == "void":
        return "<s>Tischaufruf</s> — dieses Spiel fällt weg."
    s = app.store
    mates, opp = _opponents(app, m, pid)
    head = (f"mit {esc(', '.join(mates))} " if mates else "") + f"gegen {esc(opp)}"
    if m.status == "done":
        side = _side_of(m, pid)
        won = m.winner == side
        if m.meta.get("walkover"):
            return f"{'✅' if won else '▫️'} {head}\nkampflos {'gewonnen' if won else 'verloren'}"
        mine = _mine(m.games, side)
        a = sum(1 for x, y in mine if x > y)
        b = sum(1 for x, y in mine if y > x)
        return (f"{'✅' if won else '▫️'} {head}\n{games_line(mine)} — "
                f"{'gewonnen' if won else 'verloren'} {a}:{b}")
    return (f"↩️ {head}\nZurückgestellt — du bekommst gleich einen neuen Aufruf.")


def reminder(app, r, cup, start, now):
    s = app.store
    day = _day_word(start, now)
    d = datetime.fromtimestamp(start)
    venue = (s.event.get("venue") or "").split(",")[0].strip()
    lines = [f"<b>{esc(day)} um {d.hour}:{d.minute:02d}: {esc(s.event.get('name') or '')}</b>"
             + (f"\n{esc(venue)}" if venue else ""),
             "",
             f"Du bist angemeldet: {esc(cup.name if cup else '')}{_reg_detail(s, r)}. Kommst du?"]
    kb = [[button("👍 Bin dabei", f"y:{r.id}"), button("Kann nicht", f"yn:{r.id}")]]
    return "\n".join(lines), kb


def thanks(app, ents):
    s = app.store
    lines = ["<b>Danke fürs Mitspielen!</b> 🏓", ""]
    for e in ents:
        cup = s.cups.get(e.cup_id)
        w, l = _record(s, e)
        place = _place(app, e)
        lines.append(f"<b>{esc(cup.name if cup else s.event.get('name') or '')}</b>: "
                     f"{w} {'Sieg' if w == 1 else 'Siege'} · {l} "
                     f"{'Niederlage' if l == 1 else 'Niederlagen'}"
                     + (f" · {place}" if place else ""))
    return "\n".join(lines)


def _record(s, e):
    w = l = 0
    for m in s.matches.values():
        if m.status != "done" or e.id not in (m.entrant_a, m.entrant_b):
            continue
        side = "a" if m.entrant_a == e.id else "b"
        if m.winner == side:
            w += 1
        else:
            l += 1
    return w, l


MEDALS = {1: "🥇 1. Platz", 2: "🥈 2. Platz", 3: "🥉 3. Platz"}


def _place(app, e):
    s = app.store
    cup = s.cups.get(e.cup_id)
    f = s.formats.get(cup.format_id) if cup and cup.format_id else None
    if not f:
        return ""
    for p in app._podium(f):
        if p["name"] == e.name:
            return MEDALS.get(p["place"], "")
    return ""


def _reg_detail(s, r):
    if r.kind == "pair" and r.partner_name:
        return f" mit {esc(r.partner_name)}"
    if r.kind == "seeking":
        mate = s.registrations.get(r.matched_with or "")
        return f" mit {esc(mate.name)} (zugelost)" if mate else " · Partner:in gesucht"
    return ""


# ------------------------------------------------------------------- scores

_SCORE_TEXT = re.compile(r"^\s*(\d{1,2}\s*[:\-–]\s*\d{1,2}[\s,;/]*)+$")
_SCORE_PAIR = re.compile(r"(\d{1,2})\s*[:\-–]\s*(\d{1,2})")


def parse_score(text):
    """'11:7 9:11 11-5' -> [[11,7],[9,11],[11,5]], the writer's side first."""
    if not text or not _SCORE_TEXT.match(text):
        return None
    games = [[int(a), int(b)] for a, b in _SCORE_PAIR.findall(text)]
    return games or None


# -------------------------------------------------------------- conversation

WELCOME = ("Hier sagen wir dir Bescheid, wenn du dran bist:\n"
           "⏳ wenn du gleich dran bist\n"
           "🏓 wenn dein Tisch frei ist\n\n"
           "Und für die nächsten Abende meldest du dich hier mit einem Tipp an.")
HINT = "<i>Schreib einfach hier, wenn du der Orga etwas sagen willst.</i>"
ACK_EVERY = 10 * 60


class Me:
    """Who a Telegram account is tonight: the person the door linked it to,
    their entries, and the entrants they are playing as."""

    def __init__(self, person, regs, ents):
        self.person, self.regs, self.ents = person, regs, ents


class Conversation:
    def __init__(self, bot):
        self.bot = bot
        self.app = bot.app
        self.wire = bot.wire

    @property
    def store(self):
        return self.app.store

    # ----------------------------------------------------------- identity

    def who(self, uid):
        s = self.store
        person = s.person_by_tg(uid)
        regs = [r for r in (s.registrations[i] for i in s.registration_order
                            if i in s.registrations)
                if r.status not in ("dropped", "duplicate", "cancelled")
                and (r.tg_id == uid or (person and r.person_id == person.id))]
        pids = {p.id for p in s.players.values()
                if person and p.person_id == person.id}
        for r in regs:           # confirmed before this account was linked
            e = s.entrants.get(r.entrant_id or "")
            if e and r.tg_id == uid:
                pids.add(e.player_ids[0])
        ents = [e for e in sorted(s.entrants.values(), key=lambda e: e.id)
                if pids & set(e.player_ids)]
        return Me(person, regs, ents)

    def _mine(self, uid, eid):
        """The entrant, if this account is allowed to speak for it."""
        with self.store.lock:
            me = self.who(uid)
            return next((e for e in me.ents if e.id == eid), None), me

    # ------------------------------------------------------------- updates

    def on_update(self, u):
        if "message" in u:
            msg = u["message"]
            if (msg.get("chat") or {}).get("type") == "private" and msg.get("from"):
                self.on_message(msg)
        elif "callback_query" in u:
            self.on_callback(u["callback_query"])
        elif "my_chat_member" in u:
            cm = u["my_chat_member"]
            if (cm.get("chat") or {}).get("type") == "private":
                status = (cm.get("new_chat_member") or {}).get("status")
                self.wire.set_chat(cm["chat"]["id"], blocked=int(status == "kicked"))
                self.bot.changed()

    def on_message(self, msg):
        user = msg["from"]
        uid = user["id"]
        fresh = self.wire.chat(uid) is None
        self.wire.upsert_chat(user)
        if fresh:
            self.bot.changed()
        text = (msg.get("text") or "").strip()
        chat = self.wire.chat(uid)
        if not text:
            return self.say(uid, "Hier kommt nur Text an — schreib einfach, was du sagen willst.")
        if text.startswith("/"):
            self.wire.set_chat(uid, pending="")
            cmd, _, arg = text.partition(" ")
            cmd = cmd.split("@")[0].lower()
            if cmd == "/start":
                return self.on_start(uid, arg.strip(), fresh)
            if cmd == "/stop":
                return self.on_stop(uid)
            return self.show_card(uid)
        pending = json.loads(chat.get("pending") or "{}") if chat else {}
        if pending.get("ask"):
            self.wire.set_chat(uid, pending="")
            return self.on_answer(uid, pending, text)
        games = parse_score(text)
        if games and self.store.event.get("player_scores"):
            if self.on_score(uid, games):
                return
        self.to_orga(uid, text)

    def on_start(self, uid, arg, fresh):
        user = self.wire.chat(uid) or {}
        hello = f"Hallo {esc(user.get('first_name') or '')}! 👋"
        if arg.startswith("r_"):
            out = self.bot.system("tg_attach", {"token": arg[2:], "tg_id": uid,
                                                "tg_name": self._handle(user)})
            if out is None:
                return self.show_card(uid, f"{hello}\nDieser Link ist nicht mehr gültig.")
            return self.show_card(uid, f"{hello}\n✓ Verknüpft: <b>{esc(out['name'])}</b>, "
                                       f"{esc(out['cup'])}.\n\n{WELCOME}")
        if arg.startswith("p_"):
            pid = self.wire.take_token(arg[2:])
            if not pid or pid not in self.store.people:
                return self.show_card(uid, f"{hello}\nDieser Link ist abgelaufen — "
                                           "lass dir am Eingang einen neuen zeigen.")
            self.bot.system("tg_link", {"person_id": pid, "tg_id": uid,
                                        "tg_name": self._handle(user)})
            name = self.store.people[pid].name
            return self.show_card(uid, f"{hello}\n✓ Du bist <b>{esc(name)}</b>. "
                                       f"Ab jetzt sagen wir dir Bescheid, wenn du dran bist.")
        return self.show_card(uid, f"{hello}\n{WELCOME}" if fresh else "")

    def on_stop(self, uid):
        self.wire.set_chat(uid, news=0)
        self.bot.changed()
        with self.store.lock:
            linked = bool(self.who(uid).person)
        kb = [[button("🔗 Auch Tischaufrufe beenden", "su?")]] if linked else None
        self.say(uid, "🔕 Keine Neuigkeiten mehr von uns."
                 + ("\nTischaufrufe bekommst du weiter, solange du verknüpft bist." if linked else ""),
                 kb)

    @staticmethod
    def _handle(user):
        if user.get("username"):
            return "@" + user["username"]
        return " ".join(x for x in (user.get("first_name"), user.get("last_name")) if x)

    # ----------------------------------------------------------- the card

    def card(self, uid, notice=""):
        s = self.store
        with s.lock:
            me = self.who(uid)
            phase = s.phase()
            lines = [f"<b>{esc(s.event.get('name') or 'Tischtennis')}</b>"]
            w = when_line(s)
            if w:
                lines.append(w)
            if notice:
                lines += ["", notice]
            kb = []
            if phase in ("announced", "registration"):
                lines.append("")
                lines += self._card_entry(me, kb)
            elif phase in ("doors", "live"):
                lines.append("")
                lines += self._card_live(me, kb)
                lines += ["", HINT]
            else:
                lines.append("")
                lines += self._card_done(me)
            foot = []
            app_url = self.bot.app_url()
            if app_url:
                foot.append({"text": "📱 Mein Abend", "web_app": {"url": app_url}})
            foot.append(button("⚙️", "s"))
            kb.append(foot)
            return "\n".join(lines), kb

    def _card_entry(self, me, kb):
        s = self.store
        lines, shown = [], False
        for cid in s.cup_order:
            cup = s.cups.get(cid)
            if not cup:
                continue
            reg = next((r for r in me.regs if r.cup_id == cid), None)
            pair = cup.entry == "pair"
            if reg:
                shown = True
                done = reg.status == "confirmed"
                lines.append(f"✓ <b>{esc(cup.name)}</b>{_reg_detail(s, reg)}"
                             + (" — bestätigt" if done else ""))
                if reg.rsvp == "yes":
                    lines[-1] += " · 👍"
                if not done:
                    kb.append([button(f"✓ {cup.name} · abmelden …", f"x?:{reg.id}")])
            elif cup.registration == "open" and not s.shows_console():
                shown = True
                f = s.formats.get(cup.format_id or "")
                about = [x for x in ("Doppel" if pair else "Einzel",
                                     KIND_DE.get(f.kind, "") if f else "") if x]
                lines.append(f"<b>{esc(cup.name)}</b> · {esc(' · '.join(about))}"
                             + (f"\n<i>{esc(cup.blurb)}</i>" if cup.blurb else ""))
                many = len([c for c in s.cups.values() if c.registration == "open"]) > 1
                pre = f"{cup.name}: " if many else ""
                if pair:
                    kb.append([button(f"👥 {pre}Mit Partner:in", f"r:{cid}:p"),
                               button("🔎 Partner:in gesucht", f"r:{cid}:k")])
                else:
                    kb.append([button(f"✋ {pre}Ich bin dabei", f"r:{cid}:s")])
        if not shown:
            lines.append("Die Anmeldung ist noch nicht offen — wir sagen dir hier Bescheid.")
        return lines

    def _row_for(self, eid):
        """The board row this entrant is in, if any — the same running order
        the wall shows."""
        from . import board
        s = self.store
        e = s.entrants.get(eid)
        cup = e.cup_id if e and e.cup_id in s.cups else None
        f = next((s.formats[i] for i in s.format_order if i in s.formats
                  and s.formats[i].status == "running"
                  and s.cup_of_format(s.formats[i]) == cup), None)
        if not f:
            return None
        b = board.cup_board(s, s.cup_key(f), self.app)
        return next((r for r in b["up"] if eid in (r.get("entrants") or [])), None)

    def state_of(self, e):
        """Where one entrant is tonight, as data: the card says it in a line,
        the Mini App as its headline. One place, so they cannot disagree."""
        s = self.store
        st = self.app.entrant_status(e)
        out = {"state": st, "table": "", "match": None, "opponent": "", "partners": [],
               "label": "", "best_of": "", "eta_min": None, "position": None,
               "on_deck": False, "tables": ""}
        if st == "playing":
            for t in s.tables.values():
                m = s.matches.get(t.match_id) if t.match_id else None
                if m and e.id in (m.entrant_a, m.entrant_b, *(m.meta.get("queued") or [])):
                    pid = next((p for p in e.player_ids if p in m.players()), e.player_ids[0])
                    mates, opp = _opponents(self.app, m, pid)
                    out.update(table=table_de(t), match=m.id, opponent=opp, partners=mates,
                               label=label_de(m.label), best_of=best_of(m),
                               bo=m.scoring.best_of, need=m.scoring.games_to_win())
                    break
        elif st in ("waiting", "drawn"):
            r = self._row_for(e.id)
            if r:
                out.update(on_deck=bool(r.get("on_deck")), eta_min=r.get("eta_min"),
                           position=r.get("position"), label=label_de(r.get("label", "")))
                if r["kind"] == "fixture":
                    other = [x for x in r.get("entrants") or [] if x and x != e.id]
                    out["opponent"] = s.entrant_name(other[0]) if other else ""
        out["won"], out["lost"] = _record(s, e)
        return out

    def _card_live(self, me, kb):
        s = self.store
        if not me.ents:
            waiting = [r for r in me.regs if r.status == "pending"]
            if waiting:
                cup = s.cups.get(waiting[0].cup_id)
                return [f"Du stehst auf der Liste für <b>{esc(cup.name if cup else '')}</b> — "
                        "am Eingang bestätigen wir dich."]
            return ["Heute bist du nicht eingetragen — sag am Eingang Bescheid."]
        lines = []
        many = len(me.ents) > 1
        for e in me.ents:
            cup = s.cups.get(e.cup_id)
            tag = f"<b>{esc(cup.name)}</b>: " if cup and (many or len(s.cups) > 1) else ""
            pre = f"{cup.name}: " if cup and many else ""
            x = self.state_of(e)
            st = x["state"]
            if st == "playing":
                line = (f"🏓 Jetzt an {esc(x['table']) or 'einem Tisch'}"
                        + (f" gegen {esc(x['opponent'])}" if x["opponent"] else ""))
            elif st in ("waiting", "drawn"):
                if x["on_deck"]:
                    line = "⏳ Gleich bist du dran"
                elif x["eta_min"] is not None:
                    line = f"⏱ Etwa {x['eta_min']} Min · {x['position']}. in der Reihe"
                else:
                    line = "✓ Im Turnier — gerade kein Spiel für dich"
            elif st == "resting":
                line = "⏸ Pause — du wirst nicht aufgerufen"
            elif st == "entered":
                line = "✓ Dabei — es geht gleich los"
            elif st == "withdrawn":
                line = "🏠 Für heute abgemeldet"
            else:
                line = "✓ Eingetragen"
            if x["won"] or x["lost"]:
                line += f"\n    Bisher {x['won']}:{x['lost']}"
            lines.append(tag + line)
            if st == "resting":
                kb.append([button(f"▶ {pre}Ich bin wieder da", f"p:{e.id}:0"),
                           button("🏠 Ich gehe heim …", f"g?:{e.id}")])
            elif st == "withdrawn":
                kb.append([button(f"↩ {pre}Doch noch da", f"g0:{e.id}")])
            elif st != "playing":
                kb.append([button(f"⏸ {pre}Pause", f"p:{e.id}:1")])
        return lines

    def _card_done(self, me):
        s = self.store
        played = [e for e in me.ents if any(_record(s, e))]
        if not played:
            return ["Vorbei — danke an alle, die da waren!"]
        return thanks(self.app, played).split("\n")

    def show_card(self, uid, notice=""):
        """A fresh card at the bottom of the chat, and the old one gone, so
        there is only ever one and it is always the latest."""
        text, kb = self.card(uid, notice)
        old = (self.wire.chat(uid) or {}).get("card_msg")
        sent = self.bot.api("sendMessage", {
            "chat_id": uid, "text": text, "parse_mode": "HTML",
            "link_preview_options": {"is_disabled": True},
            "reply_markup": {"inline_keyboard": kb}})
        if sent:
            self.wire.set_chat(uid, card_msg=sent["message_id"],
                               card_hash=self.card_hash(uid))
            if old:
                self.bot.api("deleteMessage", {"chat_id": uid, "message_id": old}, quiet=True)

    def edit(self, uid, message_id, text, kb=None):
        params = {"chat_id": uid, "message_id": message_id, "text": text,
                  "parse_mode": "HTML", "link_preview_options": {"is_disabled": True}}
        if kb is not None:
            params["reply_markup"] = {"inline_keyboard": kb}
        self.bot.api("editMessageText", params, quiet=True)

    def say(self, uid, text, kb=None, reply=False, placeholder=""):
        params = {"chat_id": uid, "text": text, "parse_mode": "HTML",
                  "link_preview_options": {"is_disabled": True}}
        if kb:
            params["reply_markup"] = {"inline_keyboard": kb}
        elif reply:
            params["reply_markup"] = {"force_reply": True,
                                      "input_field_placeholder": placeholder[:64]}
        return self.bot.api("sendMessage", params)

    # ----------------------------------------------------------- buttons

    def on_callback(self, q):
        uid = q["from"]["id"]
        self.wire.upsert_chat(q["from"])
        data = q.get("data") or ""
        msg = q.get("message") or {}
        mid = msg.get("message_id")
        on_card = mid and mid == (self.wire.chat(uid) or {}).get("card_msg")
        verb, _, arg = data.partition(":")
        toast = ""
        try:
            toast = self.dispatch(uid, verb, arg, mid, on_card) or ""
        except ValueError as e:
            toast = str(e)[:190]
        self.bot.api("answerCallbackQuery", {"callback_query_id": q["id"],
                                             "text": toast}, quiet=True)

    def refresh(self, uid, mid, notice=""):
        text, kb = self.card(uid, notice)
        self.edit(uid, mid, text, kb)
        if mid == (self.wire.chat(uid) or {}).get("card_msg"):
            self.wire.set_chat(uid, card_hash=self.card_hash(uid))

    def card_hash(self, uid):
        """What the card says with no one-off notice on it. The card keeps
        itself current (Bot.refresh_cards), and this is how it knows the
        player's situation changed rather than just the moment passing."""
        import hashlib
        text, kb = self.card(uid)
        return hashlib.sha1((text + json.dumps(kb)).encode()).hexdigest()[:16]

    def dispatch(self, uid, verb, arg, mid, on_card):
        s = self.store
        if verb == "c":
            return self.refresh(uid, mid)

        # entering
        if verb == "r":
            cup_id, _, kind = arg.partition(":")
            return self.enter(uid, cup_id, kind, mid)
        if verb == "n":
            cup_id, kind, how = (arg.split(":") + ["", "", ""])[:3]
            chat = self.wire.chat(uid) or {}
            if how == "y":
                self.wire.set_chat(uid, name=" ".join(x for x in (
                    chat.get("first_name"), chat.get("last_name")) if x))
                return self.enter(uid, cup_id, kind, mid)
            self.wire.set_chat(uid, pending=json.dumps(
                {"ask": "name", "cup": cup_id, "kind": kind, "mid": mid}))
            self.say(uid, "Wie heißt du? Vor- und Nachname, so wie am Eingang.",
                     reply=True, placeholder="Vor- und Nachname")
            return ""
        if verb == "x?":
            reg = self._my_reg(uid, arg)
            cup = s.cups.get(reg.cup_id)
            self.edit(uid, mid, f"<b>{esc(cup.name if cup else '')}</b> — wirklich abmelden?",
                      [[button("Ja, abmelden", f"x!:{reg.id}"), button("Zurück", "c")]])
            return ""
        if verb == "x!":
            reg = self._my_reg(uid, arg)
            # their own call, like cancelling with the web link: the desk
            # says so instead of calling it a no-show
            self.bot.system("update_registration", {"id": reg.id, "status": "cancelled"})
            self.refresh(uid, mid)
            return "Abgemeldet"

        # the reminder
        if verb in ("y", "yn", "yu"):
            reg = self._my_reg(uid, arg, any_status=True)
            if verb == "y":
                self.bot.system("tg_rsvp", {"id": reg.id, "rsvp": "yes"})
                self.edit(uid, mid, "👍 Super, bis dann!")
                return ""
            if verb == "yn":
                self.bot.system("update_registration", {"id": reg.id, "status": "cancelled"})
                self.edit(uid, mid, "Schade! Du bist abgemeldet.",
                          [[button("Doch dabei", f"yu:{reg.id}")]])
                return ""
            self.bot.system("update_registration", {"id": reg.id, "status": "pending"})
            self.edit(uid, mid, "👍 Wieder angemeldet — bis dann!")
            return ""

        # tonight
        if verb in ("p", "g?", "g!", "g0"):
            eid, _, flag = arg.partition(":")
            e, me = self._mine(uid, eid)
            if not e:
                raise ValueError("Das kannst nur du selbst ändern.")
            if verb == "p":
                rest = flag == "1"
                self.bot.system("set_resting", {"entrant_id": e.id, "resting": rest})
                if on_card:
                    return self.refresh(uid, mid)
                self.wire.keep(uid, mid)
                if rest:
                    self.edit(uid, mid, "⏸ Okay, Pause — wir rufen dich nicht auf.",
                              [[button("▶ Ich bin wieder da", f"p:{e.id}:0")]])
                else:
                    self.edit(uid, mid, "▶ Willkommen zurück — du bist wieder in der Reihe.")
                return ""
            if verb == "g?":
                self.edit(uid, mid, "🏠 Gehst du für heute? Deine offenen Spiele "
                                    "gehen dann kampflos an deine Gegner:innen.",
                          [[button("Ja, ich gehe", f"g!:{e.id}"), button("Zurück", "c")]])
                return ""
            if verb == "g!":
                self.bot.system("withdraw", {"entrant_id": e.id, "withdrawn": True})
                self.refresh(uid, mid)
                return "Gute Heimfahrt!"
            self.bot.system("withdraw", {"entrant_id": e.id, "withdrawn": False})
            self.refresh(uid, mid)
            return "Schön, dass du noch da bist!"

        # settings
        if verb == "s":
            return self.settings(uid, mid)
        if verb == "sn":
            self.wire.set_chat(uid, news=int(arg == "1"))
            self.bot.changed()
            return self.settings(uid, mid)
        if verb == "su?":
            self.edit(uid, mid, "Dann bekommst du keine Tischaufrufe mehr, und wir kennen "
                                "dich hier nicht mehr. Sicher?",
                      [[button("Ja, lösen", "su!"), button("Zurück", "s")]])
            return ""
        if verb == "su!":
            with s.lock:
                me = self.who(uid)
            if me.person:
                self.bot.system("tg_link", {"person_id": me.person.id, "tg_id": None})
            for r in me.regs:
                if r.tg_id == uid and r.status == "pending":
                    self.bot.system("tg_detach", {"id": r.id})
            self.refresh(uid, mid, "🔗 Verknüpfung gelöst.")
            return ""

        # results
        if verb in ("k+", "k-"):
            return self.on_claim_answer(uid, int(arg or 0), verb == "k+", mid)
        return ""

    def _my_reg(self, uid, rid, any_status=False):
        s = self.store
        with s.lock:
            me = self.who(uid)
            reg = s.registrations.get(rid)
            ok = reg and (reg.tg_id == uid or (me.person and reg.person_id == me.person.id))
        if not ok:
            raise ValueError("Das ist nicht deine Anmeldung.")
        if not any_status and reg.status != "pending":
            raise ValueError("Die ist schon am Eingang bestätigt.")
        return reg

    def settings(self, uid, mid):
        chat = self.wire.chat(uid) or {}
        with self.store.lock:
            me = self.who(uid)
        news = bool(chat.get("news", 1))
        lines = ["⚙️ <b>Einstellungen</b>", "",
                 f"Neuigkeiten: <b>{'an' if news else 'aus'}</b> — neue Abende und Ansagen der Orga."]
        if me.person:
            lines.append(f"Du bist hier: <b>{esc(me.person.name)}</b>")
        kb = [[button("🔕 Neuigkeiten aus" if news else "🔔 Neuigkeiten an",
                      f"sn:{0 if news else 1}")]]
        if me.person or any(r.tg_id == uid for r in me.regs):
            kb.append([button("🔗 Verknüpfung lösen …", "su?")])
        kb.append([button("← Zurück", "c")])
        self.edit(uid, mid, "\n".join(lines), kb)
        return ""

    # ------------------------------------------------------------ entering

    def enter(self, uid, cup_id, kind, mid):
        s = self.store
        with s.lock:
            cup = s.cups.get(cup_id)
            me = self.who(uid)
            if not cup:
                raise ValueError("Das gibt es nicht mehr.")
            if any(r.cup_id == cup_id for r in me.regs):
                self.refresh(uid, mid)
                return "Du bist schon angemeldet ✓"
            name = me.person.name if me.person else ""
        chat = self.wire.chat(uid) or {}
        name = name or chat.get("name") or ""
        if not name:
            full = " ".join(x for x in (chat.get("first_name"), chat.get("last_name")) if x)
            self.edit(uid, mid, "Unter welchem Namen sollen wir dich eintragen?",
                      [[button(f"✓ {full}", f"n:{cup_id}:{kind}:y")] if full else [],
                       [button("✏️ Anderer Name", f"n:{cup_id}:{kind}:e")],
                       [button("← Zurück", "c")]])
            return ""
        if kind == "p":
            self.wire.set_chat(uid, pending=json.dumps(
                {"ask": "partner", "cup": cup_id, "kind": kind, "mid": mid}))
            self.say(uid, "Mit wem spielst du? Vor- und Nachname deiner Partnerin "
                          "oder deines Partners.", reply=True, placeholder="Partner:in")
            return ""
        return self._register(uid, cup_id, kind, name, "", mid)

    def register(self, uid, cup_id, kind, name, partner=""):
        """An entry for this account, whichever screen it came from. `kind`
        is s (single), p (with a partner) or k (looking for one). Entering
        a cup you are already in hands back that entry instead."""
        s = self.store
        with s.lock:
            me = self.who(uid)
            have = next((r for r in me.regs if r.cup_id == cup_id), None)
            if have:
                cup = s.cups.get(cup_id)
                return {"registration_id": have.id, "cup": cup.name if cup else "",
                        "matched_with": "", "already": True}
            name = me.person.name if me.person else " ".join((name or "").split())[:60]
            if not name:
                raise ValueError("Wir brauchen deinen Namen.")
            if kind == "p" and not (partner or "").strip():
                raise ValueError("Wie heißt deine Partnerin oder dein Partner?")
            return self.bot.system("tg_register", {
                "cup_id": cup_id, "tg_id": uid, "name": name,
                "kind": {"p": "pair", "k": "seeking"}.get(kind, "single"),
                "partner_name": partner or ""})

    def _register(self, uid, cup_id, kind, name, partner, mid):
        out = self.register(uid, cup_id, kind, name, partner)
        extra = (f"\nDu spielst mit <b>{esc(out['matched_with'])}</b>."
                 if out.get("matched_with") else "")
        notice = f"✓ Angemeldet für <b>{esc(out['cup'])}</b>.{extra}"
        if mid:
            self.refresh(uid, mid, notice)
        else:
            self.show_card(uid, notice)
        return "Angemeldet ✓"

    def on_answer(self, uid, pending, text):
        text = " ".join(text.split())[:60]
        cup, kind, mid = pending.get("cup"), pending.get("kind"), pending.get("mid")
        try:
            if pending["ask"] == "name":
                self.wire.set_chat(uid, name=text)
                return self.enter(uid, cup, kind, None)
            if pending["ask"] == "partner":
                chat = self.wire.chat(uid) or {}
                with self.store.lock:
                    me = self.who(uid)
                name = me.person.name if me.person else chat.get("name") or ""
                self._register(uid, cup, kind, name, text, None)
        except ValueError as e:
            self.say(uid, esc(str(e)))

    # ------------------------------------------------------------- the orga

    def to_orga(self, uid, text):
        self.wire.note(uid, "in", text[:2000])
        self.bot.changed()
        chat = self.wire.chat(uid) or {}
        now = time.time()
        if now - (chat.get("last_ack") or 0) > ACK_EVERY:
            self.wire.set_chat(uid, last_ack=now)
            self.say(uid, "✓ Ist bei der Orga angekommen.")

    # -------------------------------------------------------------- scores

    def _live_for(self, uid):
        """The match this account is on a table in right now, and which side."""
        s = self.store
        me = self.who(uid)
        if not me.person:
            return None, None, None
        pids = {p.id for p in s.players.values() if p.person_id == me.person.id}
        for t in s.tables.values():
            m = s.matches.get(t.match_id) if t.match_id else None
            if m and m.status == "live" and pids & set(m.players()):
                pid = next(iter(pids & set(m.players())))
                return m, _side_of(m, pid), pid
        return None, None, None

    def claim(self, uid, games_mine):
        """A score from one side of a table, the writer's points first.
        Shared by the chat and the Mini App; returns what came of it:

          not_playing   they are on no table, so it was not a score
          invalid       it does not decide the match
          sent          the other side has been asked
          agreed        the other side had said the same; it is written
          disputed      the other side had said something else
          no_opponent   nobody on the other side is on Telegram"""
        s = self.store
        with s.lock:
            m, side, pid = self._live_for(uid)
            if not m:
                return {"status": "not_playing"}
            games = _mine(games_mine, side)     # back to a/b
            if not decide_winner(games, m.scoring):
                return {"status": "invalid", "need": m.scoring.games_to_win(),
                        "best_of": best_of(m)}
            other = "b" if side == "a" else "a"
            from .notify import reach_map
            reach = reach_map(s, self.bot.ok_chats())
            theirs = sorted({reach[p] for p in (m.side_b if side == "a" else m.side_a)
                             if p in reach})
            opp = self.app.side_name(m, other)
            me_name = self.app.side_name(m, side)
            t = s.tables.get(m.table)
            match_id, qseq = m.id, m.queued_seq
        for c in self.wire.claims_for(match_id, qseq):
            if c["side"] != side:
                if c["games"] == games:
                    self._settle(c, "agreed")
                    self._write(match_id, qseq, games)
                    return {"status": "agreed"}
                self._settle(c, "disputed")
                self._disputed(t, [(opp, games_line(_mine(c["games"], c["side"]))),
                                   (me_name, games_line(games_mine))])
                self.say(c["chat_id"], "Eure Ergebnisse passen nicht zusammen — "
                                       "bitte meldet euch beim Schiri.")
                return {"status": "disputed"}
            self._settle(c, "replaced")
        if not theirs:
            return {"status": "no_opponent", "opponent": opp}
        cid = self.wire.add_claim(match_id, qseq, side, uid, games)
        # shown the way round the reader played it: their points first
        view = _mine(games, other)
        mine_sets = sum(1 for x, y in view if x > y)
        their_sets = len(view) - mine_sets
        msgs = []
        for c in theirs:
            sent = self.say(c, f"<b>{esc(me_name)}</b> meldet für "
                               f"{esc(table_de(t)) if t else 'euer Spiel'}:\n"
                               f"{games_line(view)} — "
                               f"{'du gewinnst' if mine_sets > their_sets else 'du verlierst'} "
                               f"{mine_sets}:{their_sets}\n\nStimmt das?",
                            [[button("✓ Stimmt", f"k+:{cid}"),
                              button("✗ Stimmt nicht", f"k-:{cid}")]])
            if sent:
                msgs.append([c, sent["message_id"]])
        self.wire.set_claim_msgs(cid, msgs)
        self.bot.changed()
        return {"status": "sent", "opponent": opp}

    def answer(self, uid, cid, yes):
        """The other side's answer to a score: gone, stale, agreed, disputed."""
        c = self.wire.claim(cid)
        if not c or c["state"] != "open":
            return {"status": "gone"}
        s = self.store
        with s.lock:
            m, side, pid = self._live_for(uid)
            ok = bool(m) and m.id == c["match_id"] and side != c["side"] \
                and m.queued_seq == c["qseq"]
            t = s.tables.get(m.table) if m else None
            names = (self.app.side_name(m, c["side"]),
                     self.app.side_name(m, side)) if ok else ("", "")
        if not ok:
            self._settle(c, "stale")
            return {"status": "stale"}
        if yes:
            self._settle(c, "agreed")
            self._write(c["match_id"], c["qseq"], c["games"])
            return {"status": "agreed"}
        self._settle(c, "disputed")
        self._disputed(t, [(names[0], games_line(_mine(c["games"], c["side"]))),
                           (names[1], "that is wrong")])
        self.say(c["chat_id"], f"{esc(names[1])} sagt, das Ergebnis stimmt nicht. "
                               "Bitte meldet euch beim Schiri.")
        return {"status": "disputed"}

    SETTLED = {"agreed": "✓ Bestätigt und eingetragen.",
               "disputed": "Uneinig — bitte meldet euch beim Schiri.",
               "replaced": "Ersetzt durch eine neuere Meldung.",
               "stale": "Erledigt — das Spiel ist schon eingetragen."}

    def _settle(self, c, state):
        """Close a report, and turn every question it asked into its answer,
        wherever it was answered — chat or app."""
        self.wire.close_claim(c["id"], state)
        for chat, mid in c.get("msgs") or []:
            self.edit(chat, mid, self.SETTLED[state])
        self.bot.changed()

    def pending_claims(self, uid):
        """Reports about this account's current match: ones it is asked to
        confirm, and its own still waiting for the other side."""
        s = self.store
        with s.lock:
            m, side, pid = self._live_for(uid)
            if not m:
                return [], []
            names = {x: self.app.side_name(m, x) for x in ("a", "b")}
            match_id, qseq = m.id, m.queued_seq
        ask, mine = [], []
        for c in self.wire.claims_for(match_id, qseq):
            view = _mine(c["games"], side)
            won = sum(1 for x, y in view if x > y)
            item = {"id": c["id"], "by": names[c["side"]], "games": view,
                    "sets": [won, len(view) - won]}
            (mine if c["side"] == side else ask).append(item)
        return ask, mine

    def on_score(self, uid, games_mine):
        """A score typed into the chat. False if it was not one after all
        (they are not playing), so it goes to the orga instead."""
        r = self.claim(uid, games_mine)
        st = r["status"]
        if st == "not_playing":
            return False
        if st == "invalid":
            self.say(uid, f"Das ergibt noch keinen Sieg — bei {r['best_of']} braucht es "
                          f"{r['need']} Gewinnsätze. Zum Beispiel: 11:7 9:11 11:5")
        elif st == "disputed":
            self.say(uid, "Eure Ergebnisse passen nicht zusammen — bitte meldet euch beim Schiri.")
        elif st == "no_opponent":
            self.say(uid, f"{esc(r['opponent'])} ist nicht über Telegram verbunden — "
                          "bitte trag das Ergebnis beim Schiri ein.")
        elif st == "sent":
            self.say(uid, f"Danke! {esc(r['opponent'])} muss noch bestätigen.")
        return True

    def on_claim_answer(self, uid, cid, yes, mid):
        r = self.answer(uid, cid, yes)
        if r["status"] == "gone":
            self.edit(uid, mid, "Erledigt.")
            return ""
        return {"agreed": "Eingetragen ✓", "disputed": "Okay — ab zum Schiri"}.get(
            r["status"], "")

    def _write(self, match_id, qseq, games):
        s = self.store
        with s.lock:
            m = s.matches.get(match_id)
            if not m or m.status != "live" or m.queued_seq != qseq:
                return None
            return self.bot.system("report", {"match_id": match_id, "games": games,
                                              "by": "players"})

    def _disputed(self, t, says):
        """Tell the organisers a table needs a referee — in the console's
        language, each side's score as they typed it."""
        where = (t.name or f"Table {t.number}") if t else "A table"
        self.wire.note(None, "sys", f"{where} needs a referee: " + ", ".join(
            f"{name} says {what}" for name, what in says) + ".")
        self.bot.changed()
