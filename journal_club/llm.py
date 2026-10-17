"""LLM interface: protocol, Anthropic backend, deterministic mock, disk cache."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import random
import re
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal, Protocol

log = logging.getLogger(__name__)

DEFAULT_MODEL = "claude-opus-5-5"
DEFAULT_JUDGE_MODEL = "claude-sonnet-5-5"
MAX_TOKENS = 16000

HEADER_RE = re.compile(r"^([A-Z_]+): ?(.*)$", re.M)
# Leading whitespace allowed: render_card_for_prompt indents QUOTE lines by two spaces.
QUOTE_RE = re.compile(r"^[ \t]*QUOTE\[([^|\]]+)\|([^\]]+)\]: (.+)$", re.M)


class LLM(Protocol):
    """One method every backend implements."""

    def complete_json(self, kind: str, system: str, user: str, schema: dict) -> dict:
        """Return a dict that satisfies `schema`."""
        ...


class LLMError(RuntimeError):
    """Raised when a backend cannot produce schema-valid output."""


# ---------------------------------------------------------------- schema check


def check_schema(data: object, schema: dict) -> list[str]:
    """Return the problems of `data` against the keyword subset we use ([] = valid)."""
    problems: list[str] = []
    _walk(data, schema, "$", problems)
    return problems


_TYPES: dict[str, tuple[type, ...]] = {
    "object": (dict,),
    "array": (list,),
    "string": (str,),
    "integer": (int,),
    "number": (int, float),
    "boolean": (bool,),
    "null": (type(None),),
}


def _type_ok(data: object, t: str) -> bool:
    """Check one JSON type name, with bool excluded from integer/number."""
    if t in ("integer", "number") and isinstance(data, bool):
        return False
    return isinstance(data, _TYPES.get(t, ()))


def _walk(data: object, schema: dict, path: str, problems: list[str]) -> None:
    """Recursive schema walk collecting problems."""
    if "anyOf" in schema:
        if not any(not _probe(data, sub) for sub in schema["anyOf"]):
            problems.append(f"{path}: matches no anyOf branch")
        return
    if "enum" in schema and data not in schema["enum"]:
        problems.append(f"{path}: {data!r} not in enum {schema['enum']}")
        return
    t = schema.get("type")
    if t is not None and not _type_ok(data, t):
        problems.append(f"{path}: expected {t}, got {type(data).__name__}")
        return
    if t == "object" and isinstance(data, dict):
        props: dict[str, dict] = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in data:
                problems.append(f"{path}.{key}: missing required key")
        if schema.get("additionalProperties") is False:
            for key in data:
                if key not in props:
                    problems.append(f"{path}.{key}: unexpected key")
        for key, sub in props.items():
            if key in data:
                _walk(data[key], sub, f"{path}.{key}", problems)
    elif t == "array" and isinstance(data, list) and "items" in schema:
        for i, item in enumerate(data):
            _walk(item, schema["items"], f"{path}[{i}]", problems)


def _probe(data: object, schema: dict) -> list[str]:
    """Walk without touching the caller's problem list."""
    local: list[str] = []
    _walk(data, schema, "$", local)
    return local


# ------------------------------------------------------------------ anthropic


def resolve_model(role: Literal["main", "judge"] = "main") -> str:
    """Model id for a role, honouring JC_MODEL / JC_JUDGE_MODEL."""
    if role == "judge":
        return os.environ.get("JC_JUDGE_MODEL", DEFAULT_JUDGE_MODEL)
    return os.environ.get("JC_MODEL", DEFAULT_MODEL)


class AnthropicLLM:
    """Structured JSON through the official Anthropic SDK."""

    def __init__(self, model: str = DEFAULT_MODEL, client: Any | None = None) -> None:
        """Create the zero-arg client unless one is injected (tests)."""
        self.model = model
        if client is None:
            import anthropic

            client = anthropic.Anthropic()
        self.client = client

    def complete_json(self, kind: str, system: str, user: str, schema: dict) -> dict:
        """One messages.create call with a JSON-schema output format; SDK failures surface as LLMError."""
        import anthropic

        t0 = time.monotonic()
        try:
            resp = self.client.messages.create(
                model=self.model,
                max_tokens=MAX_TOKENS,
                system=system,
                messages=[{"role": "user", "content": user}],
                output_config={"format": {"type": "json_schema", "schema": schema}},
            )
        except anthropic.AnthropicError as exc:
            raise LLMError(f"{kind}: {type(exc).__name__}: {exc}") from exc
        elapsed = time.monotonic() - t0
        usage = getattr(resp, "usage", None)
        log.info(
            "llm kind=%s model=%s in=%s out=%s elapsed=%.1fs",
            kind,
            self.model,
            getattr(usage, "input_tokens", "?"),
            getattr(usage, "output_tokens", "?"),
            elapsed,
        )
        stop = getattr(resp, "stop_reason", None)
        if stop in ("refusal", "max_tokens"):
            raise LLMError(f"{kind}: stop_reason={stop}")
        text = next((b.text for b in resp.content if getattr(b, "type", "") == "text"), None)
        if text is None:
            raise LLMError(f"{kind}: no text block in response")
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise LLMError(f"{kind}: invalid JSON: {exc}") from exc
        problems = check_schema(data, schema)
        if problems:
            raise LLMError(f"{kind}: output violates schema: {problems[:5]}")
        return data


# ----------------------------------------------------------------------- mock


def _seed(kind: str, user: str) -> int:
    """Deterministic seed from (kind, user)."""
    return int(hashlib.sha256(f"{kind}\x00{user}".encode()).hexdigest()[:16], 16)


def parse_headers(user: str) -> dict[str, str]:
    """Header lines `NAME: value`; first occurrence wins."""
    out: dict[str, str] = {}
    for m in HEADER_RE.finditer(user):
        out.setdefault(m.group(1), m.group(2).strip())
    return out


def parse_quotes(user: str) -> list[dict[str, str]]:
    """Every QUOTE[id|loc]: text line as a Quote-shaped dict, in document order."""
    return [
        {"paper_id": m.group(1), "loc": m.group(2), "text": m.group(3).strip()}
        for m in QUOTE_RE.finditer(user)
    ]


def _fabricated(pid: str) -> dict[str, str]:
    """A quote that fails verification by design."""
    return {"paper_id": pid, "text": "no quote available", "loc": "none"}


def _first_words(text: str, n: int) -> str:
    """First n whitespace-separated words."""
    return " ".join(text.split()[:n])


def _sentences(text: str, min_len: int = 40) -> list[str]:
    """Sentences of >= min_len chars, verbatim, in order."""
    parts = re.split(r"(?<=[.!?])\s+", " ".join(text.split()))
    return [p.strip() for p in parts if len(p.strip()) >= min_len]


class MockLLM:
    """Deterministic backend: derives outputs from the prompt headers and QUOTE lines."""

    def __init__(self, scripted: dict[str, Callable[[str], dict]] | None = None) -> None:
        """Optional `scripted[kind] = fn(user) -> dict` overrides."""
        self.scripted: dict[str, Callable[[str], dict]] = dict(scripted or {})
        self.calls: list[tuple[str, str]] = []
        self._lock = threading.Lock()

    def complete_json(self, kind: str, system: str, user: str, schema: dict) -> dict:
        """Record the call, produce the result, self-validate."""
        with self._lock:
            self.calls.append((kind, user))
        fn = self.scripted.get(kind)
        result = fn(user) if fn is not None else self.default(kind, user, schema)
        problems = check_schema(result, schema)
        if problems:
            raise LLMError(f"mock output violates schema: {problems[:5]}")
        return result

    def default(self, kind: str, user: str, schema: dict) -> dict:
        """The deterministic rule for each kind (§3.1 of DESIGN.md)."""
        rng = random.Random(_seed(kind, user))
        headers = parse_headers(user)
        quotes = parse_quotes(user)
        handler = getattr(self, f"_kind_{kind}", None)
        if handler is not None:
            return handler(rng, headers, quotes, user)
        return self._generic(rng, schema, quotes, "root")

    # -- per-kind rules -------------------------------------------------------

    @staticmethod
    def _quotes_for(quotes: list[dict[str, str]], pid: str) -> list[dict[str, str]]:
        """QUOTE lines of one paper."""
        return [q for q in quotes if q["paper_id"] == pid]

    def _first_quote(self, quotes: list[dict[str, str]], pid: str) -> dict[str, str]:
        """First QUOTE line of a paper, or a fabricated one."""
        mine = self._quotes_for(quotes, pid)
        return dict(mine[0]) if mine else _fabricated(pid)

    def _kind_ingest(self, rng: random.Random, h: dict[str, str], q: list, user: str) -> dict:
        """Card fields read off the PDF text."""
        pid = h.get("PAPER_ID", "paper")
        body = user.split("TEXT:", 1)[1] if "TEXT:" in user else user
        body = body.replace("<<<PDF_TEXT_BEGIN>>>", "").replace("<<<PDF_TEXT_END>>>", "")
        lines = [ln.strip() for ln in body.splitlines() if ln.strip()]
        title = lines[0] if lines else pid
        hint = h.get("YEAR_HINT", "")
        year = int(hint) if re.fullmatch(r"\d{4}", hint) else 2020
        sents = _sentences(body)

        def item(sentence: str) -> dict:
            return {
                "text": "Claims: " + _first_words(sentence, 8),
                "quote": {"paper_id": pid, "text": sentence, "loc": "p1"},
            }

        return {
            "citekey": pid,
            "title": title,
            "year": year,
            "date": f"{year}-01-01",
            "authors": ["Mock Author"],
            "abstract": body.strip()[:300],
            "claims": [item(s) for s in sents[:2]],
            "methods": ["mock method"],
            "data": ["mock data"],
            "limits": [item(s) for s in sents[2:3]],
        }

    def _kind_map(self, rng: random.Random, h: dict[str, str], q: list, user: str) -> dict:
        """Pair relation with the first quote of each side."""
        a, b = _split_pair(h.get("PAIR", ""))
        relation = rng.choices(
            ["agree", "disagree", "shared_limitation", "unrelated"], weights=[3, 3, 3, 1]
        )[0]
        return {
            "relation": relation,
            "quote_a": self._first_quote(q, a),
            "quote_b": self._first_quote(q, b),
            "note": f"mock: {a} vs {b} ({relation})",
        }

    def _kind_debate_turn(self, rng: random.Random, h: dict[str, str], q: list, user: str) -> dict:
        """The speaker restates the claim with its own first quote."""
        s = h.get("SPEAKER", "")
        mine = self._quotes_for(q, s)
        return {
            "text": f"{s} maintains: {h.get('CLAIM', '')}",
            "quotes": [dict(mine[0])] if mine else [],
        }

    def _kind_debate_verdict(self, rng: random.Random, h: dict[str, str], q: list, user: str) -> dict:
        """Random legal verdict."""
        return {"verdict": rng.choice(["stands", "contested", "unresolved"]), "reason": "mock verdict"}

    def _kind_directions(self, rng: random.Random, h: dict[str, str], q: list, user: str) -> dict:
        """N directions, each resting on two papers' first quotes."""
        n = int(h.get("N", "0") or 0)
        ids = list(dict.fromkeys(x["paper_id"] for x in q))
        out = []
        for i in range(n):
            if not ids:
                break
            pair = rng.sample(ids, 2) if len(ids) >= 2 else [ids[0], ids[0]]
            q1, q2 = self._first_quote(q, pair[0]), self._first_quote(q, pair[1])
            from_a, to_b = _first_words(q1["text"], 6), _first_words(q2["text"], 6)
            out.append(
                {
                    "text": f"The field moves from {from_a} to {to_b} (#{i})",
                    "from_a": from_a,
                    "to_b": to_b,
                    "because": f"{pair[0]} and {pair[1]} both point there",
                    "papers": sorted(pair),
                    "quotes": [q1, q2],
                    "confidence": round(0.3 + rng.randrange(60) / 100, 2),
                }
            )
        return {"directions": out}

    _kind_baseline = _kind_directions

    def _kind_judge(self, rng: random.Random, h: dict[str, str], q: list, user: str) -> dict:
        """Random verdict naming one after-T paper unless miss."""
        after_ids = [x.strip() for x in h.get("AFTER_IDS", "").split(",") if x.strip()]
        verdict = rng.choice(["hit", "partial", "miss"])
        pid = rng.choice(after_ids) if verdict != "miss" and after_ids else None
        return {"verdict": verdict, "after_paper_id": pid, "reason": f"mock judge: {verdict}"}

    # -- generic fallback -----------------------------------------------------

    def _generic(self, rng: random.Random, schema: dict, quotes: list, field: str) -> Any:
        """Schema walk producing one plausible value."""
        if "anyOf" in schema:
            if any(s.get("type") == "null" for s in schema["anyOf"]):
                return None
            return self._generic(rng, schema["anyOf"][0], quotes, field)
        if "enum" in schema:
            return rng.choice(schema["enum"])
        t = schema.get("type")
        if t == "object":
            props: dict[str, dict] = schema.get("properties", {})
            if set(props) == {"paper_id", "text", "loc"}:
                return dict(quotes[0]) if quotes else _fabricated("none")
            return {k: self._generic(rng, sub, quotes, k) for k, sub in props.items()}
        if t == "array":
            return [self._generic(rng, schema.get("items", {}), quotes, field)]
        if t == "string":
            return f"{field} {rng.getrandbits(32):08x}"
        if t == "integer":
            return 1
        if t == "number":
            return 0.5
        if t == "boolean":
            return True
        return None


def _split_pair(value: str) -> tuple[str, str]:
    """Parse `a | b`."""
    parts = [p.strip() for p in value.split("|")]
    if len(parts) != 2:
        return value.strip(), value.strip()
    return parts[0], parts[1]


# ---------------------------------------------------------------------- cache


def cache_key(kind: str, system: str, user: str, schema: dict, model: str | None = None) -> str:
    """sha256 of the canonical JSON of the call arguments; the model joins the key when known."""
    payload: dict[str, Any] = {"kind": kind, "system": system, "user": user, "schema": schema}
    if model is not None:
        payload["model"] = model
    blob = json.dumps(payload, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()


class CachedLLM:
    """Disk cache in front of any LLM; writes only schema-valid results; keyed by the inner model too."""

    def __init__(self, inner: LLM, dir: str | Path = ".jc_cache") -> None:
        """Create the cache directory lazily on first write."""
        self.inner = inner
        self.dir = Path(dir)
        self._lock = threading.Lock()

    @property
    def model(self) -> str | None:
        """The inner backend's model id, if it has one (so a model change never serves stale answers)."""
        model = getattr(self.inner, "model", None)
        return str(model) if model is not None else None

    def _path(self, key: str) -> Path:
        """File for one key."""
        return self.dir / f"{key}.json"

    def _key(self, kind: str, system: str, user: str, schema: dict) -> str:
        """Cache key of one call under the inner model."""
        return cache_key(kind, system, user, schema, self.model)

    def complete_json(self, kind: str, system: str, user: str, schema: dict) -> dict:
        """Hit: parsed file. Miss: call inner and persist if valid."""
        key = self._key(kind, system, user, schema)
        path = self._path(key)
        with self._lock:
            if path.exists():
                log.info("cache hit kind=%s key=%s", kind, key[:12])
                return json.loads(path.read_text())
        result = self.inner.complete_json(kind, system, user, schema)
        problems = check_schema(result, schema)
        if problems:
            raise LLMError(f"{kind}: output violates schema, not cached: {problems[:5]}")
        with self._lock:
            self.dir.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(result, ensure_ascii=False))
            os.replace(tmp, path)
        return result

    def drop(self, kind: str, system: str, user: str, schema: dict) -> bool:
        """Delete one entry; True if it existed."""
        path = self._path(self._key(kind, system, user, schema))
        with self._lock:
            if path.exists():
                path.unlink()
                return True
            return False


# -------------------------------------------------------------------- factory


def get_llm(role: Literal["main", "judge"] = "main") -> LLM:
    """Backend selected by JC_LLM (mock | anthropic), cached unless JC_CACHE=0."""
    backend = os.environ.get("JC_LLM", "anthropic")
    if backend == "mock":
        return MockLLM()
    if backend == "anthropic":
        llm: LLM = AnthropicLLM(resolve_model(role))
        if os.environ.get("JC_CACHE", "1") != "0":
            llm = CachedLLM(llm)
        return llm
    raise ValueError(f"JC_LLM must be 'mock' or 'anthropic', got {backend!r}")
