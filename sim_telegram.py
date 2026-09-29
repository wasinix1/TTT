"""The Telegram layer, played through against a fake Bot API.

The fake keeps every chat's messages the way a phone would show them —
sent, edited, deleted — and lets a test be a player: type, tap a button by
its label. So what is checked here is what somebody holding the phone would
actually see, not which methods happened to be called.

    python3 sim_telegram.py       (sim.py runs it too)
"""

import json
import shutil
import sys
import tempfile
import time

from tt.server import App
from tt.telegram import Bot, TgError
from tt.simulate import play_one
from tt import simulate


def check(cond, msg):
    if not cond:
        print("  FAIL:", msg)
        sys.exit(1)
    print("  ok:", msg)


class FakeTelegram:
    def __init__(self, username="tttclub_bot"):
        self.username = username
        self.calls = []
        self.updates = []
        self.mid = 1000
        self.chats = {}           # chat -> {message_id: {"text", "kb", "reply"}}
        self.blocked = set()
        self.fail = None          # raise this once from the next call
        self.uid = 500

    # -- the API
    def __call__(self, method, params, timeout=None):
        self.calls.append((method, json.loads(json.dumps(params))))
        if self.fail:
            e, self.fail = self.fail, None
            raise e
        if method == "getMe":
            return {"id": 1, "is_bot": True, "username": self.username}
        if method in ("deleteWebhook", "setMyCommands", "answerCallbackQuery",
                      "setChatMenuButton"):
            return True
        if method == "getUpdates":
            off = params.get("offset", 0)
            return [u for u in self.updates if u["update_id"] >= off]
        chat = params.get("chat_id")
        if chat in self.blocked:
            raise TgError(403, "Forbidden: bot was blocked by the user")
        box = self.chats.setdefault(chat, {})
        if method == "sendMessage":
            self.mid += 1
            box[self.mid] = self._msg(params)
            return {"message_id": self.mid, "chat": {"id": chat}}
        if method == "editMessageText":
            old = box.get(params["message_id"])
            if old is None:
                raise TgError(400, "Bad Request: message to edit not found")
            new = self._msg(params)
            if new["text"] == old["text"] and new["kb"] == old["kb"]:
                raise TgError(400, "Bad Request: message is not modified")
            box[params["message_id"]] = new
            return {"message_id": params["message_id"]}
        if method == "deleteMessage":
            if box.pop(params["message_id"], None) is None:
                raise TgError(400, "Bad Request: message to delete not found")
            return True
        raise TgError(400, f"unknown method {method}")

    @staticmethod
    def _msg(params):
        rm = params.get("reply_markup") or {}
        return {"text": params["text"], "kb": rm.get("inline_keyboard") or [],
                "reply": bool(rm.get("force_reply"))}

    # -- being a player
    def user(self, first, last="", username=""):
        self.uid += 1
        return {"id": self.uid, "is_bot": False, "first_name": first,
                "last_name": last, "username": username}

    def _push(self, kind, body):
        self.updates.append({"update_id": len(self.updates) + 1, kind: body})

    def say(self, user, text):
        self._push("message", {"message_id": 1, "from": user, "text": text,
                               "chat": {"id": user["id"], "type": "private"}})

    def tap(self, user, label):
        """Tap the newest button whose label contains `label`."""
        box = self.chats.get(user["id"], {})
        for mid in sorted(box, reverse=True):
            for row in box[mid]["kb"]:
                for b in row:
                    if label in b["text"] and "callback_data" in b:
                        self._push("callback_query", {
                            "id": str(len(self.updates)), "from": user,
                            "data": b["callback_data"],
                            "message": {"message_id": mid,
                                        "chat": {"id": user["id"], "type": "private"}}})
                        return True
        raise AssertionError(f"no button {label!r} in {self.texts(user)}")

    def texts(self, user):
        box = self.chats.get(user["id"], {})
        return [box[m]["text"] for m in sorted(box)]

    def seen(self, user, needle):
        return any(needle in t for t in self.texts(user))

    def sent(self, method, chat=None):
        return [p for m, p in self.calls if m == method
                and (chat is None or p.get("chat_id") == chat)]


def fresh(connect=True):
    d = tempfile.mkdtemp()
    app = App(d)
    fake = FakeTelegram()
    app.telegram = Bot(app, d, transport=fake)
    if connect:
        app.act("admin", "tg_connect", {"token": "123:abc", "url": "https://tt.example/"})
    return app, fake, d


def event(app, entry="single", kind="open_play", tables=2, phase="registration",
          config=None):
    app.act("admin", "create_event", {
        "name": "Oktober Open", "starts_at": "2099-10-17T19:00", "venue": "Funkhaus",
        "cups": [{"name": "Einzel", "entry": entry, "registration": "open",
                  "kind": kind, "config": config or {"mode": "singles"}}],
        "tables": [{"name": f"Table {i + 1}", "cup": -1} for i in range(tables)]})
    app.act("admin", "set_phase", {"phase": phase})
    return app.store.cup_order[0]


def start_draw(app, cup):
    app.act("admin", "set_phase", {"phase": "live"})
    app.act("admin", "start_format", {"id": app.store.cups[cup].format_id})


def restart(app, fake, d):
    """A new server process on the same data, talking to the same Telegram."""
    app.store.conn.close()
    again = App(d)
    again.telegram = Bot(again, d, transport=fake)
    return again


# -------------------------------------------------------------------- tests

def test_off_changes_nothing():
    print("\n[telegram off: nothing changes]")
    app, fake, d = fresh(connect=False)
    cup = event(app)
    out = app.act("public", "register", {"cup_id": cup, "name": "Jana Berger"})
    check("telegram" not in out, "a web entry gets no Telegram link")
    check(app.public_state()["telegram"] == "", "the landing page offers none")
    check(app.state("admin")["telegram"]["on"] is False, "the console says it is off")
    app.telegram.pump()
    check(not fake.calls, "and nothing was ever sent anywhere")
    shutil.rmtree(d)


def test_connecting():
    print("\n[connecting the bot]")
    app, fake, d = fresh(connect=False)
    try:
        app.act("admin", "tg_connect", {"token": "nonsense"})
        check(False, "a token without a colon is refused")
    except ValueError as e:
        check("token" in str(e), "a token without a colon is refused")
    fake.fail = TgError(401, "Unauthorized")
    try:
        app.act("admin", "tg_connect", {"token": "1:bad"})
        check(False, "a token Telegram rejects is refused")
    except ValueError as e:
        check("does not know" in str(e), "a token Telegram rejects is refused, saying so")
    out = app.act("admin", "tg_connect", {"token": "123:abc", "url": "https://tt.example/"})
    check(out["username"] == "tttclub_bot", "a good one connects as the bot")
    st = app.state("admin")
    check(st["telegram"]["on"] and st["telegram"]["username"] == "tttclub_bot",
          "the console shows which bot")
    blob = json.dumps(st) + json.dumps(app.public_state()) + json.dumps(app.store.history(500))
    check("123:abc" not in blob, "the token is in no state and not in the log")
    check(app.state("public")["telegram"] == {"on": True, "username": "tttclub_bot"},
          "the public console only learns the bot's name")
    shutil.rmtree(d)


def test_web_entry_links_at_the_door():
    print("\n[a web entry, its Telegram link, and the door]")
    app, fake, d = fresh()
    s = app.store
    cup = event(app)
    out = app.act("public", "register", {"cup_id": cup, "name": "Jana Berger"})
    check(out["telegram"].startswith("https://t.me/tttclub_bot?start=r_"),
          "the web form hands back a private link into the bot")
    jana = fake.user("Jana", "B.", "jana")
    fake.say(jana, "/start " + out["telegram"].split("start=")[1])
    app.telegram.pump()
    check(fake.seen(jana, "Verknüpft: <b>Jana Berger</b>"), "opening it says whose entry it is")
    reg = s.registrations[out["registration_id"]]
    check(reg.tg_id == jana["id"], "the entry now carries the account")
    check(s.person_by_tg(jana["id"]) is None, "but it is nobody yet — the door has not seen her")

    app.act("admin", "set_phase", {"phase": "doors"})
    app.act("admin", "admit", {"registration_id": reg.id})
    who = s.person_by_tg(jana["id"])
    check(who is not None and who.name == "Jana Berger", "confirming her links the account")
    check(who.tg_name == "@jana", "and the console can show which account")
    shutil.rmtree(d)


def test_a_name_is_not_an_identity():
    print("\n[calling yourself somebody gets you nothing of theirs]")
    app, fake, d = fresh()
    s = app.store
    cup = event(app, phase="doors")
    real = fake.user("Jana", "Berger")
    fake.say(real, "/start")
    app.telegram.pump()
    app.act("admin", "admit", {"cup_id": cup, "name": "Jana Berger"})
    pid = s.players[next(iter(s.players))].person_id
    link = app.act("admin", "tg_door_link", {"person_id": pid})["url"]
    fake.say(real, "/start " + link.split("start=")[1])
    app.telegram.pump()
    check(s.people[pid].tg_id == real["id"], "the door's QR code links the real one")
    fake.say(real, "/start " + link.split("start=")[1])
    app.telegram.pump()
    check(fake.seen(real, "abgelaufen"), "and a QR code works once")

    fake_jana = fake.user("Jana", "Berger")
    fake.say(fake_jana, "/start")
    app.act("admin", "admit", {"cup_id": cup, "name": "Bo Lind"})
    start_draw(app, cup)
    app.telegram.pump()
    check(fake.seen(real, "Du bist dran"), "the real Jana is called to her table")
    check(not fake.seen(fake_jana, "Du bist dran"), "the one who only has her name is not")
    check(s.person_by_tg(fake_jana["id"]) is None, "and is linked to nobody")
    shutil.rmtree(d)


def test_one_tap_entry():
    print("\n[entering from the bot]")
    app, fake, d = fresh()
    s = app.store
    cup = event(app)
    new = fake.user("Milo", "Graf")
    fake.say(new, "/start")
    app.telegram.pump()
    check(fake.seen(new, "Einzel"), "the card shows what is open")
    fake.tap(new, "Ich bin dabei")
    app.telegram.pump()
    check(fake.seen(new, "Unter welchem Namen"), "a stranger is asked which name, once")
    fake.tap(new, "✓ Milo Graf")
    app.telegram.pump()
    regs = s.pending_regs()
    check(len(regs) == 1 and regs[0].name == "Milo Graf" and regs[0].tg_id == new["id"],
          "one more tap and the entry is in, carrying the account")
    fake.tap(new, "abmelden")
    app.telegram.pump()
    fake.tap(new, "Ja, abmelden")
    app.telegram.pump()
    check(not s.pending_regs(), "and it can be taken back from the same card")

    # the door links him; next month he is somebody
    fake.tap(new, "Ich bin dabei")
    app.telegram.pump()
    app.act("admin", "set_phase", {"phase": "doors"})
    app.act("admin", "admit", {"registration_id": s.pending_regs()[0].id})
    app.act("admin", "create_event", {
        "name": "November Open", "starts_at": "2099-11-14T19:00",
        "cups": [{"name": "Einzel", "entry": "single", "registration": "open",
                  "kind": "open_play", "config": {"mode": "singles"}}]})
    app.act("admin", "set_phase", {"phase": "registration"})
    fake.say(new, "/start")
    app.telegram.pump()
    check(fake.seen(new, "November Open"), "the card is about the new event")
    fake.tap(new, "Ich bin dabei")
    app.telegram.pump()
    r = s.pending_regs()[0]
    who = s.person_by_tg(new["id"])
    check(r.person_id == who.id and r.name == "Milo Graf",
          "a known player is entered with one tap, as themselves")
    fake.say(new, "/start")
    app.telegram.pump()
    check(not any("Ich bin dabei" in b["text"] for m in fake.chats[new["id"]].values()
                  for row in m["kb"] for b in row),
          "and the card offers no second entry")
    fake._push("callback_query", {"id": "again", "from": new, "data": f"r:{s.cup_order[0]}:s",
                                  "message": {"message_id": 1, "chat": {"id": new["id"]}}})
    app.telegram.pump()
    check(len(s.pending_regs()) == 1, "even a stale button does not enter them twice")
    shutil.rmtree(d)


def test_doubles_entry():
    print("\n[entering a doubles cup from the bot]")
    app, fake, d = fresh()
    s = app.store
    cup = event(app, entry="pair", kind="groups", config={})
    a, b, c = fake.user("Ada", "Kern"), fake.user("Ben", "Ott"), fake.user("Cleo", "Sand")
    for u in (a, b, c):
        fake.say(u, "/start")
        app.telegram.pump()
    fake.tap(a, "Mit Partner:in")
    app.telegram.pump()
    fake.tap(a, "✓ Ada Kern")
    app.telegram.pump()
    check(fake.chats[a["id"]][max(fake.chats[a["id"]])]["reply"],
          "choosing a partner asks for their name")
    fake.say(a, "Dora Fink")
    app.telegram.pump()
    r = s.pending_regs()[0]
    check(r.kind == "pair" and r.partner_name == "Dora Fink", "and enters the two of them")
    fake.tap(b, "Partner:in gesucht")
    app.telegram.pump()
    fake.tap(b, "✓ Ben Ott")
    app.telegram.pump()
    fake.tap(c, "Partner:in gesucht")
    app.telegram.pump()
    fake.tap(c, "✓ Cleo Sand")
    app.telegram.pump()
    check(fake.seen(c, "Du spielst mit <b>Ben Ott</b>"),
          "two people looking are told who they play with")
    shutil.rmtree(d)


def linked_players(app, fake, cup, names):
    """Admit these at the door and link each to a Telegram account."""
    s = app.store
    users = []
    for n in names:
        u = fake.user(n)
        fake.say(u, "/start")
        app.telegram.pump()
        out = app.act("admin", "admit", {"cup_id": cup, "name": n})
        pid = s.players[s.entrants[out["entrant_id"]].player_ids[0]].person_id
        link = app.act("admin", "tg_door_link", {"person_id": pid})["url"]
        fake.say(u, "/start " + link.split("start=")[1])
        app.telegram.pump()
        u["eid"] = out["entrant_id"]
        users.append(u)
    return users


def test_two_messages_per_match():
    print("\n[up next, your turn — and nothing else]")
    app, fake, d = fresh()
    s = app.store
    cup = event(app, tables=1, phase="doors")
    us = linked_players(app, fake, cup, ["Ana", "Bea", "Cai", "Dev"])
    before = len(fake.sent("sendMessage"))
    start_draw(app, cup)
    app.telegram.pump()
    on = [u for u in us if fake.seen(u, "Du bist dran — Tisch 1")]
    nxt = [u for u in us if fake.seen(u, "Gleich bist du dran")]
    check(len(on) == 2, "the two on the table are called to Tisch 1")
    check(len(nxt) == 2 and not set(map(id, on)) & set(map(id, nxt)),
          "the next two are told to get ready")
    calls = len(fake.sent("sendMessage"))
    app.telegram.pump()
    app.telegram.pump()
    check(len(fake.sent("sendMessage")) == calls, "saying it again sends nothing")

    m = s.matches[s.tables[1].match_id]
    app.act("referee", "report", {"match_id": m.id, "games": [[11, 7], [11, 5]]})
    app.telegram.pump()
    winner = next(u for u in on if s.entrants[u["eid"]].id == m.entrant_a)
    check(fake.seen(winner, "11:7 · 11:5 — gewonnen 2:0"), "the table call became the result")
    check(not any(fake.seen(u, "Du bist dran — Tisch 1") and u in on for u in [winner]),
          "in place, not as another message")
    called = [u for u in nxt if fake.seen(u, "Du bist dran — Tisch 1")]
    check(len(called) == 2, "the next two are called")
    check(not any(fake.seen(u, "Gleich bist du dran") for u in called),
          "and their get-ready message is gone, replaced by the call")

    # a restart remembers everything it said
    n = len(fake.sent("sendMessage"))
    app = restart(app, fake, d)
    app.telegram.pump()
    check(len(fake.sent("sendMessage")) == n, "a restarted server repeats nothing")
    shutil.rmtree(d)


def test_put_back_and_rewind():
    print("\n[a match put back, or rewound, says so]")
    app, fake, d = fresh()
    s = app.store
    cup = event(app, tables=1, phase="doors")
    us = linked_players(app, fake, cup, ["Ana", "Bea", "Cai", "Dev"])
    start_draw(app, cup)
    app.telegram.pump()
    mark = s.seq
    m = s.matches[s.tables[1].match_id]
    first = [u for u in us if u["eid"] in (m.entrant_a, m.entrant_b)]
    app.act("admin", "put_back", {"match_id": m.id})
    app.telegram.pump()
    check(all(fake.seen(u, "Zurückgestellt") or fake.seen(u, "fällt weg") for u in first),
          "putting a match back edits its table call")
    app.act("admin", "rewind", {"seq": mark})
    app.telegram.pump()
    check(sum(fake.seen(u, "Du bist dran") for u in us) >= 2,
          "a rewind that seats them again calls them again")
    shutil.rmtree(d)


def test_the_card_keeps_itself_true():
    print("\n[the card is a live status, not a snapshot]")
    app, fake, d = fresh()
    s = app.store
    cup = event(app, tables=1, phase="doors")
    ana, bea, cai = linked_players(app, fake, cup, ["Ana", "Bea", "Cai"])
    start_draw(app, cup)
    for u in (ana, bea, cai):
        fake.say(u, "/start")
    app.telegram.pump()
    m = s.matches[s.tables[1].match_id]
    on = next(u for u in (ana, bea, cai) if u["eid"] == m.entrant_a)
    card = lambda u: fake.chats[u["id"]][app.telegram.wire.chat(u["id"])["card_msg"]]["text"]
    check("Jetzt an Tisch 1" in card(on), "while playing, the card says where")
    n = len(fake.sent("sendMessage"))
    app.act("referee", "report", {"match_id": m.id, "games": [[11, 3], [11, 3]]})
    app.telegram.pump()
    check("Bisher 1:0" in card(on) or "Bisher 0:1" in card(on),
          "after the match it moves on by itself")
    sent_now = [p for p in fake.sent("sendMessage")[n:] if p["chat_id"] == on["id"]]
    check(all("Du bist dran" in p["text"] or "Gleich" in p["text"] for p in sent_now),
          "by editing — the only new messages are the two that matter")
    calls = len(fake.calls)
    app.telegram.pump()
    check(not [c for c in fake.calls[calls:] if c[0] == "editMessageText"],
          "and nothing is edited when nothing changed")
    shutil.rmtree(d)


def test_the_sandbox_never_messages():
    print("\n[the sandbox cannot message anybody]")
    app, fake, d = fresh()
    cup = event(app, phase="doors")
    linked_players(app, fake, cup, ["Ana", "Bea"])
    app.act("admin", "sim_start", {"per_cup": 6, "rounds": 1, "seed": 3})
    check(app.sim.app.telegram is None, "the sandbox has no bot")
    n = len(fake.calls)
    for t in list(app.sim.app.store.tables):
        play_one(app.sim.app, t)
    app.telegram.pump()
    check(not [c for c in fake.calls[n:] if c[0] == "sendMessage"],
          "playing it out sends nothing")
    app.act("admin", "sim_stop", {})
    shutil.rmtree(d)


def test_players_speak_only_for_themselves():
    print("\n[sitting out, only yourself]")
    app, fake, d = fresh()
    s = app.store
    cup = event(app, tables=1, phase="doors")
    ana, bea, cai = linked_players(app, fake, cup, ["Ana", "Bea", "Cai"])
    start_draw(app, cup)
    fake.say(cai, "/start")
    app.telegram.pump()
    idle = next(u for u in (ana, bea, cai) if app.entrant_status(s.entrants[u["eid"]]) != "playing")
    fake.say(idle, "/start")
    app.telegram.pump()
    fake.tap(idle, "Pause")
    app.telegram.pump()
    check(idle["eid"] in s.opted_out, "a player can sit themselves out from the card")
    check(fake.seen(idle, "Pause — du wirst nicht aufgerufen"), "and the card says so")
    other = next(u for u in (ana, bea, cai) if u is not idle)
    fake._push("callback_query", {"id": "x", "from": other, "data": f"p:{idle['eid']}:0",
                                  "message": {"message_id": 1, "chat": {"id": other["id"]}}})
    app.telegram.pump()
    check(idle["eid"] in s.opted_out, "nobody else can bring them back")
    fake.tap(idle, "wieder da")
    app.telegram.pump()
    check(idle["eid"] not in s.opted_out, "they can")
    fake.tap(idle, "Pause")
    app.telegram.pump()
    fake.tap(idle, "Ich gehe heim")
    app.telegram.pump()
    fake.tap(idle, "Ja, ich gehe")
    app.telegram.pump()
    check(not s.entrants[idle["eid"]].active, "going home is there, one step behind pausing")
    shutil.rmtree(d)


def test_cant_right_now():
    print("\n[can't play right now, from the get-ready message]")
    app, fake, d = fresh()
    s = app.store
    cup = event(app, tables=1, phase="doors")
    us = linked_players(app, fake, cup, ["Ana", "Bea", "Cai", "Dev"])
    start_draw(app, cup)
    app.telegram.pump()
    u = next(u for u in us if fake.seen(u, "Gleich bist du dran"))
    check(not fake.seen(u, "gegen"), "out of a queue, get-ready names no opponent it cannot promise")
    fake.tap(u, "Kann gerade nicht")
    app.telegram.pump()
    check(u["eid"] in s.opted_out, "one tap sits them out")
    check(fake.seen(u, "Okay, Pause"), "the message says so, and stays")
    app.telegram.pump()
    fake.tap(u, "Ich bin wieder da")
    app.telegram.pump()
    check(u["eid"] not in s.opted_out, "and the way back is on the same message")
    shutil.rmtree(d)


def test_players_enter_scores():
    print("\n[scores from both sides]")
    app, fake, d = fresh()
    s = app.store
    cup = event(app, tables=1, phase="doors")
    ana, bea = linked_players(app, fake, cup, ["Ana", "Bea"])
    start_draw(app, cup)
    app.telegram.pump()
    fake.say(ana, "11:7 11:5")
    app.telegram.pump()
    m = s.matches[s.tables[1].match_id]
    check(m.status == "live", "with the switch off, a score is just a message")
    check(any(t["name"] == "Ana" for t in app.state("admin")["telegram"]["threads"]),
          "that lands with the organisers")

    app.act("admin", "event_meta", {"player_scores": True})
    app.telegram.pump()
    fake.say(ana, "11:7 9:11 11-5")
    app.telegram.pump()
    check(fake.seen(bea, "7:11 · 11:9 · 5:11 — du verlierst 1:2"),
          "the other side is asked, the way round they played it")
    check(m.status == "live", "nothing is written on one side's word")
    fake.tap(bea, "✓ Stimmt")
    app.telegram.pump()
    check(m.status == "done" and m.games == [[11, 7], [9, 11], [11, 5]]
          if m.entrant_a == ana["eid"] else m.games == [[7, 11], [11, 9], [5, 11]],
          "confirming writes it")
    check(any(h["payload"].get("by") == "players" for h in s.history(10)),
          "and the log says the players entered it")
    check(fake.seen(ana, "gewonnen 2:1"), "the table call becomes the result for both")
    shutil.rmtree(d)


def test_disagreement_goes_to_the_organisers():
    print("\n[two different scores]")
    app, fake, d = fresh()
    s = app.store
    cup = event(app, tables=1, phase="doors")
    app.act("admin", "event_meta", {"player_scores": True})
    ana, bea = linked_players(app, fake, cup, ["Ana", "Bea"])
    start_draw(app, cup)
    app.telegram.pump()
    m = s.matches[s.tables[1].match_id]
    fake.say(ana, "11:7 11:5")
    fake.say(bea, "11:7 11:5")          # Bea says she won by the same
    app.telegram.pump()
    check(m.status == "live", "two different results write nothing")
    tg = app.state("admin")["telegram"]
    check(any(t["system"] and "Table 1 needs a referee" in t["messages"][-1]["text"]
              for t in tg["threads"]),
          "and the organisers are told which table")
    fake.say(ana, "11:9 11:9")
    fake.say(bea, "9:11 9:11")
    app.telegram.pump()
    check(m.status == "done", "the same result from both sides is agreement")
    shutil.rmtree(d)


def test_talking_to_the_room():
    print("\n[newsletter, live messages, and replies]")
    app, fake, d = fresh()
    s = app.store
    cup = event(app)
    fans = [fake.user(n) for n in ("Una", "Vic", "Wes")]
    for u in fans:
        fake.say(u, "/start")
    app.telegram.pump()
    fake.say(fans[2], "/stop")
    app.telegram.pump()
    out = app.act("admin", "tg_send", {"audience": "followers", "text": "Freitag geht's los",
                                       "announce": True})
    check(out["sent"] == 2, "the newsletter goes to followers who did not opt out")
    app.telegram.pump()
    check(fake.seen(fans[0], "Neuer Termin!") and fake.seen(fans[0], "Freitag geht"),
          "an announcement is the event card itself")
    fake.tap(fans[0], "Ich bin dabei")
    app.telegram.pump()
    fake.tap(fans[0], "✓ Una")
    app.telegram.pump()
    check(len(s.pending_regs()) == 1, "and its button enters them")

    fake.blocked.add(fans[1]["id"])
    app.act("admin", "tg_send", {"audience": "followers", "text": "Noch Plätze frei"})
    app.telegram.pump()
    check(app.telegram.wire.chat(fans[1]["id"])["blocked"] == 1,
          "somebody who blocked the bot is noted, not retried")
    check(app.state("admin")["telegram"]["followers"] == 1, "and stops counting")

    fake.say(fans[0], "Ich komme 10 Minuten später")
    app.telegram.pump()
    tg = app.state("admin")["telegram"]
    th = next(t for t in tg["threads"] if t["chat_id"] == fans[0]["id"])
    check(th["unread"] == 1 and th["name"] == "Una", "a player's message reaches the Chat tab")
    check(tg["unread"] >= 1, "with an unread count for the tab")
    check(fake.seen(fans[0], "bei der Orga angekommen"), "and they know it arrived")
    app.act("admin", "tg_send", {"audience": "chat", "chat_id": fans[0]["id"],
                                 "text": "Kein Problem!"})
    app.telegram.pump()
    check(fake.seen(fans[0], "<b>Orga:</b> Kein Problem!"), "a reply goes straight back")
    th = next(t for t in app.state("admin")["telegram"]["threads"]
              if t["chat_id"] == fans[0]["id"])
    check(th["unread"] == 0 and th["messages"][-1]["dir"] == "out",
          "and shows in the thread, read")
    shutil.rmtree(d)


def test_the_reminder():
    print("\n[the day before]")
    app, fake, d = fresh()
    s = app.store
    cup = event(app)
    start = time.time() + 20 * 3600
    app.act("admin", "event_meta", {"starts_at": time.strftime("%Y-%m-%dT%H:%M",
                                                                time.localtime(start))})
    u = fake.user("Ida", "Rot")
    fake.say(u, "/start")
    app.telegram.pump()
    fake.tap(u, "Ich bin dabei")
    app.telegram.pump()
    fake.tap(u, "✓ Ida Rot")
    app.telegram.pump()
    check(not fake.seen(u, "Kommst du?"), "somebody who just entered is not asked yet")
    r = s.pending_regs()[0]
    r.created_ts -= 8 * 3600             # as if they entered this morning
    app.telegram.pump()
    check(fake.seen(u, "Kommst du?"), "the day before, they are asked")
    app.telegram.pump()
    check(sum("Kommst du?" in t for t in fake.texts(u)) == 1, "once")
    fake.tap(u, "Kann nicht")
    app.telegram.pump()
    check(s.registrations[r.id].status == "dropped", "no drops the entry")
    fake.tap(u, "Doch dabei")
    app.telegram.pump()
    check(s.registrations[r.id].status == "pending", "and changing their mind puts it back")
    shutil.rmtree(d)


def test_network_trouble_loses_nothing():
    print("\n[a network blip delays, never drops]")
    app, fake, d = fresh()
    s = app.store
    cup = event(app, tables=1, phase="doors")
    ana, bea = linked_players(app, fake, cup, ["Ana", "Bea"])
    start_draw(app, cup)
    app.telegram.plan(force=True)
    fake.fail = TgError(0, "network: unreachable")
    app.telegram.flush()
    check(not fake.seen(ana, "Du bist dran"), "while Telegram is unreachable nothing arrives")
    check(app.state("admin")["telegram"]["ok"] is False, "the console says so")
    app.telegram.pump()
    check(fake.seen(ana, "Du bist dran") and fake.seen(bea, "Du bist dran"),
          "and once it is back, the calls go out")
    shutil.rmtree(d)


# ------------------------------------------------------------- the mini app

def test_the_mini_app_knows_who_is_asking():
    print("\n[the Mini App trusts only what Telegram signed]")
    from tt import me
    user = {"id": 42, "first_name": "Jana"}
    good = me.sign(user, "123:abc")
    check(me.verify(good, "123:abc")["id"] == 42, "a signed request is somebody")
    check(me.verify(good, "999:zzz") is None, "signed for another bot, it is nobody")
    check(me.verify(good.replace("Jana", "Tom"), "123:abc") is None,
          "changing a single letter breaks it")
    old = me.sign(user, "123:abc", auth_date=time.time() - 2 * 86400)
    check(me.verify(old, "123:abc") is None, "and it does not last for ever")
    check(me.verify("", "123:abc") is None and me.verify("hash=x", "123:abc") is None,
          "nothing, or junk, is nobody")


def http(app):
    import http.client, threading
    from http.server import ThreadingHTTPServer
    from tt.server import Handler
    Handler.app = app
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]

    def req(method, path, init="", body=None):
        c = http.client.HTTPConnection("127.0.0.1", port)
        h = {"X-Tg-Init": init, "Content-Type": "application/json"}
        c.request(method, path, json.dumps(body) if body is not None else None, h)
        r = c.getresponse()
        out = r.status, json.loads(r.read() or b"{}")
        c.close()
        return out
    return srv, req


def test_the_mini_app_door():
    print("\n[the Mini App over HTTP]")
    from tt import me
    app, fake, d = fresh()
    cup = event(app)
    srv, req = http(app)
    jana = fake.user("Jana", "Berger")
    init = me.sign(jana, "123:abc")
    check(req("GET", "/api/me")[0] == 401, "without Telegram's signature there is nothing to see")
    check(req("GET", "/api/me", me.sign(jana, "1:wrong"))[0] == 401,
          "nor with a forged one")
    st, v = req("GET", "/api/me", init)
    check(st == 200 and v["open"][0]["id"] == cup, "signed, it shows what is open")
    check(app.telegram.wire.chat(jana["id"]) is not None,
          "opening the app before the chat still makes them somebody the bot can reach")
    st, out = req("POST", "/api/me", init, {"op": "enter", "data": {
        "cup_id": cup, "kind": "s", "name": "Jana Berger"}})
    check(st == 200 and out["view"]["entries"][0]["cup"] == "Einzel",
          "entering is one request, and the view comes back with it")
    check(app.store.pending_regs()[0].tg_id == jana["id"], "carrying the account, like the bot")
    st, out = req("POST", "/api/me", init, {"op": "rest", "data": {"eid": "E1", "on": True}})
    check(st == 400, "nobody can act for an entrant that is not theirs")
    app.act("admin", "tg_disconnect", {})
    check(req("GET", "/api/me", init)[0] == 404, "with the bot switched off, the app is gone")
    srv.shutdown()
    shutil.rmtree(d)


def test_the_mini_app_on_the_night():
    print("\n[the Mini App on the night: status, score, confirm]")
    from tt import me
    app, fake, d = fresh()
    s = app.store
    cup = event(app, tables=1, phase="doors")
    app.act("admin", "event_meta", {"player_scores": True})
    ana, bea, cai = linked_players(app, fake, cup, ["Ana", "Bea", "Cai"])
    start_draw(app, cup)
    app.telegram.pump()
    m = s.matches[s.tables[1].match_id]
    on = [u for u in (ana, bea, cai) if u["eid"] in (m.entrant_a, m.entrant_b)]
    off = next(u for u in (ana, bea, cai) if u not in on)
    x = me.view(app.telegram, on[0]["id"])["tonight"][0]
    check(x["state"] == "playing" and x["table"] == "Tisch 1" and x["need"] == 2,
          "a player on a table sees which, and what it takes to win")
    w = me.view(app.telegram, off["id"])
    check(w["tonight"][0]["state"] in ("waiting", "drawn") and w["tables"][0]["a"],
          "the one waiting sees their place and who is on the table")

    out = me.act(app.telegram, on[0], "score", {"games": [[11, 4], [11, 6]]})
    check("bestätigt" in out["toast"], "a score from the app asks the other side")
    ask = me.view(app.telegram, on[1]["id"])["confirm"]
    check(len(ask) == 1 and ask[0]["games"] == [[4, 11], [6, 11]],
          "who sees it in their app, the right way round")
    check(fake.seen(on[1], "Stimmt das?"), "and in their chat, in case the app is closed")
    out = me.act(app.telegram, on[1], "confirm", {"id": ask[0]["id"], "yes": True})
    check(m.status == "done", "confirming in the app writes it")
    check(fake.seen(on[1], "Bestätigt und eingetragen") and not fake.seen(on[1], "Stimmt das?"),
          "and the question in the chat turns into the answer")
    check(me.view(app.telegram, on[0]["id"])["matches"][0]["won"],
          "the result is in the reporter's evening")

    try:
        me.act(app.telegram, off, "score", {"games": [[11, 0], [11, 0]]})
        ok = False
    except ValueError:
        ok = True
    check(ok or app.entrant_status(s.entrants[off["eid"]]) == "playing",
          "somebody not on a table cannot report a score")
    shutil.rmtree(d)


def test_the_menu_button_opens_the_app():
    print("\n[the Mini App is one tap from the chat]")
    app, fake, d = fresh()
    menus = fake.sent("setChatMenuButton")
    check(menus and menus[-1]["menu_button"]["web_app"]["url"] == "https://tt.example/tg",
          "connecting puts the app beside every player's message box")
    event(app)
    u = fake.user("Ida")
    fake.say(u, "/start")
    app.telegram.pump()
    box = fake.chats[u["id"]]
    kb = box[max(box)]["kb"]
    check(any(b.get("web_app", {}).get("url") == "https://tt.example/tg" for row in kb for b in row),
          "and the card opens it too")
    shutil.rmtree(d)
    app2, fake2, d2 = fresh(connect=False)
    app2.act("admin", "tg_connect", {"token": "1:a", "url": "http://192.168.1.5:8000/"})
    check(fake2.sent("setChatMenuButton")[-1]["menu_button"] == {"type": "commands"},
          "on a hall LAN with no public address, the button stays Telegram's own")
    shutil.rmtree(d2)


def run():
    test_off_changes_nothing()
    test_connecting()
    test_web_entry_links_at_the_door()
    test_a_name_is_not_an_identity()
    test_one_tap_entry()
    test_doubles_entry()
    test_two_messages_per_match()
    test_put_back_and_rewind()
    test_the_card_keeps_itself_true()
    test_the_sandbox_never_messages()
    test_players_speak_only_for_themselves()
    test_cant_right_now()
    test_players_enter_scores()
    test_disagreement_goes_to_the_organisers()
    test_talking_to_the_room()
    test_the_reminder()
    test_network_trouble_loses_nothing()
    test_the_mini_app_knows_who_is_asking()
    test_the_mini_app_door()
    test_the_mini_app_on_the_night()
    test_the_menu_button_opens_the_app()


if __name__ == "__main__":
    run()
    print("\nall good\n")
