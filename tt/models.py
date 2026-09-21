"""Data models. Everything here is derived state, rebuilt from the event log."""

from dataclasses import dataclass, field, asdict
from typing import Optional


@dataclass
class Scoring:
    best_of: int = 3
    points_to: int = 11
    win_by: int = 2

    def games_to_win(self) -> int:
        return self.best_of // 2 + 1

    def to_dict(self):
        return asdict(self)

    @staticmethod
    def from_dict(d):
        d = d or {}
        return Scoring(
            best_of=int(d.get("best_of", 3)),
            points_to=int(d.get("points_to", 11)),
            win_by=int(d.get("win_by", 2)),
        )


@dataclass
class Person:
    """Somebody the club knows, as opposed to somebody playing tonight.

    Venue-level state, like tables and cups: an event clears its roster, this
    outlives it. What it is really for is the strength — a name is as fast to
    type as to search for, but the number you tuned by eye last month is a
    judgement worth keeping, and it is what makes a returning player's first
    pairing a good one."""
    id: str
    name: str
    strength: float = 5.0
    note: str = ""
    last_seen: str = ""            # the event id they last played in

    def to_dict(self):
        return asdict(self)


@dataclass
class Player:
    id: str
    name: str
    strength: float = 5.0          # 1..10, organiser estimate
    active: bool = True
    person_id: Optional[str] = None   # who they are in the club directory

    def to_dict(self):
        return asdict(self)


@dataclass
class Entrant:
    """A competing unit: one player (singles / scramble pool) or a fixed pair."""
    id: str
    name: str
    player_ids: list[str]
    active: bool = True
    cup_id: str = ""        # the pool they were admitted to; "" = no cup

    def to_dict(self):
        return asdict(self)


@dataclass
class Match:
    id: str
    format_id: str
    side_a: list[str] = field(default_factory=list)   # player ids
    side_b: list[str] = field(default_factory=list)
    entrant_a: Optional[str] = None
    entrant_b: Optional[str] = None
    label: str = ""
    meta: dict = field(default_factory=dict)          # group / round / bracket wiring
    scoring: Scoring = field(default_factory=Scoring)
    table: Optional[int] = None
    status: str = "pending"                           # pending|live|done|void
    games: list[list[int]] = field(default_factory=list)
    winner: Optional[str] = None                      # 'a' | 'b'
    seq: int = 0
    queued_seq: int = 0
    # wall-clock, taken from the event log so a replay reproduces them: how
    # long matches actually take is what turns a queue position into a time
    started_ts: Optional[float] = None
    done_ts: Optional[float] = None

    def duration(self) -> Optional[float]:
        if self.started_ts and self.done_ts and self.done_ts > self.started_ts:
            return self.done_ts - self.started_ts
        return None

    def is_filled(self) -> bool:
        return bool(self.entrant_a and self.entrant_b)

    def players(self) -> list[str]:
        return list(self.side_a) + list(self.side_b)

    def to_dict(self):
        d = asdict(self)
        d["scoring"] = self.scoring.to_dict()
        return d


@dataclass
class Table:
    number: int
    name: str = ""
    paused: bool = False
    match_id: Optional[str] = None
    cup_id: Optional[str] = None       # None = shared; tagged = reserved for that cup

    def to_dict(self):
        return asdict(self)


@dataclass
class Cup:
    """A sub-tournament inside the event, and the unit of entry: a
    registration names exactly one cup, and confirming it lands the entrant
    in that cup's nominated format."""
    id: str
    name: str
    blurb: str = ""                    # one line for the landing page
    entry: str = "single"              # single | pair — what the form asks for
    registration: str = "closed"       # open | closed
    format_id: Optional[str] = None    # where confirmations land

    def to_dict(self):
        return asdict(self)


@dataclass
class Registration:
    """Somebody who put their name down before the night.

    An intent, not an entry: it creates no Player and no Entrant, so nothing
    the dispatcher can see comes from the public side of the wall. It becomes
    real only when an admin confirms whoever actually turned up."""
    id: str
    cup_id: str
    kind: str = "single"           # single | pair | seeking (a partner)
    name: str = ""
    strength: float = 5.0          # claimed, not authoritative
    partner_name: str = ""
    partner_strength: float = 5.0
    team_name: str = ""
    note: str = ""
    status: str = "pending"        # pending | confirmed | dropped
    entrant_id: Optional[str] = None
    created_ts: float = 0.0

    def to_dict(self):
        return asdict(self)


@dataclass
class QueueEntry:
    entrant_id: str
    format_id: str
    joined_seq: int
    passes: int = 0        # dispatch rounds survived without being matched

    def to_dict(self):
        return asdict(self)


def decide_winner(games: list[list[int]], scoring: Scoring) -> Optional[str]:
    need = scoring.games_to_win()
    a = sum(1 for g in games if g[0] > g[1])
    b = sum(1 for g in games if g[1] > g[0])
    if a >= need:
        return "a"
    if b >= need:
        return "b"
    return None
