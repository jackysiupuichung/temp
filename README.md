# Library Journal Club

Eight papers become eight PhD-student agents. In one night they map every pair
(agree / disagree / shared limitation), debate the clashes under a PI, and write
ranked research directions, each backed by verbatim quotes from the papers. A
backtest splits the library at a date T, holds out the later papers as the answer
key, and scores the club's directions against a one-call baseline with a judge on a
different model.

Design: `journal_club/DESIGN.md` (the contract) and
`research/review/organisation_diagram.md` (the figures).

## Setup

```sh
uv sync
uv run pytest -q
```

Python >= 3.12. Dependencies: anthropic, pydantic v2, pypdf, typer.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `JC_LLM` | `anthropic` | `mock` for the deterministic offline backend |
| `JC_MODEL` | `claude-opus-5-5` | PI and student model |
| `JC_JUDGE_MODEL` | `claude-sonnet-5-5` | backtest judge (a different model) |
| `JC_CACHE` | `1` | `0` disables the on-disk response cache (`.jc_cache/`) |
| `JC_CONCURRENCY` | `4` | parallel LLM calls in the map and judge steps |

The Anthropic client is `anthropic.Anthropic()` with no arguments; it reads
`ANTHROPIC_API_KEY` or an `ant auth login` profile.

## Commands

```sh
uv run jc ingest PDF_DIR CARDS_DIR
uv run jc run CARDS_DIR --out runs/night1 --agenda "batch correction"
uv run jc backtest CARDS_DIR --t 2023-01-01 --out runs/bt1 --agenda "batch correction"
uv run jc minutes runs/night1
```

`RUN_DIR` holds `events.jsonl` (append-only archive), `minutes.md` and, for a
backtest, `report.md`. Running `run` or `backtest` again into the same `RUN_DIR`
resumes it: every finished step is rebuilt from the append-only archive with zero
LLM calls and only what is missing is computed (`--resume` is accepted and
implied). A different card set in the same `RUN_DIR` is refused (`ResumeMismatch`,
exit 1); a changed agenda is logged as an `agenda_changed` event.

`ingest` keeps going when one PDF fails (unreadable file, or no claim whose quote
verifies): the others are written, the failures are listed, and the exit code is 1.

## Quote gate

Every claim, verdict and direction must carry a quote that string-matches the
source card after normalisation (`journal_club/quotes.py`). Quotes that fail are
logged as `quote_rejected`, `turn_unverified` or `direction_rejected` events and
counted in the minutes. The gate stops invented quotes; it cannot tell whether a PDF
itself contains false sentences, so ingested cards should be read by the person who
picks the papers before a night runs.
