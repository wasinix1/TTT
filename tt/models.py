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
class Player:
    id: str
    name: str
    strength: float = 5.0          # 1..10, organiser estimate
    active: bool = True

    def to_dict(self):
        return asdict(self)


@dataclass
class Entrant:
    """A competing unit: one player (singles / scramble pool) or a fixed pair."""
    id: str
    name: str
    player_ids: list[str]
    active: bool = True

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
