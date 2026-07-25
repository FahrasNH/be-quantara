#!/usr/bin/env python3
"""Convert markdown tables in strategy docs to vertical stacked format."""

import re
import sys
from pathlib import Path

DOCS = [
    "AF_SMC.md", "AF_VSA.md", "AF_WYCKOFF.md",
    "BS_BR.md", "BS_ICT.md", "BS_LS.md",
    "MD_MR.md", "MD_SA.md", "MD_SD.md",
    "TS_TF.md", "TS_MS.md", "TS_VP.md",
]

RISK_HEADERS = {
    "leg", "entry tf / htf", "sl method", "tp method",
    "atr mult / r:r", "risk %", "notes",
}
EXEC_HEADERS = {"limit", "value", "ssot"}
TRADE_TYPE_HEADERS = {"type", "entry tf", "trend / htf tf", "real money", "dry-run / backtest"}


def normalize_header(h: str) -> str:
    return re.sub(r"\s+", " ", h.strip().lower())


def strip_md_bold(s: str) -> str:
    return re.sub(r"^\*\*(.+)\*\*$", r"\1", s.strip())


def is_separator_row(row: str) -> bool:
    cells = [c.strip() for c in row.strip().strip("|").split("|")]
    return all(re.match(r"^:?-+:?$", c) for c in cells if c)


def parse_table_row(row: str) -> list[str]:
    return [c.strip() for c in row.strip().strip("|").split("|")]


def convert_table(headers: list[str], rows: list[list[str]], context: str) -> str:
    norm = [normalize_header(h) for h in headers]
    n = len(headers)

    # Risk & SL/TP per leg
    if norm[0] == "leg" and "sl method" in norm:
        out = []
        idx = {normalize_header(h): i for i, h in enumerate(headers)}
        for row in rows:
            leg = row[idx["leg"]].strip("*")
            out.append(f"### {leg}\n")
            for key in ["entry tf / htf", "sl method", "tp method", "atr mult / r:r", "risk %", "notes"]:
                if key in idx:
                    label = key.replace("atr mult / r:r", "ATR mult / R:R").replace("risk %", "Risk %")
                    label = label.replace("notes", "Notes")
                    label = label.replace("entry tf / htf", "Entry TF / HTF").replace("sl method", "SL method").replace("tp method", "TP method")
                    out.append(f"- **{label}:** {row[idx[key]]}")
            out.append("")
        return "\n".join(out).rstrip()

    # Execution limits
    if norm == ["limit", "value", "ssot"]:
        blocks = []
        for i, row in enumerate(rows):
            block = (
                f"**Limit:** {row[0]}\n"
                f"**Value:** {row[1]}\n"
                f"**SSOT:** {row[2]}"
            )
            if i < len(rows) - 1:
                block += "\n\n---"
            blocks.append(block)
        return "\n".join(blocks)

    # Trade types
    if norm[0] == "type" and "entry tf" in norm:
        out = []
        idx = {normalize_header(h): i for i, h in enumerate(headers)}
        for row in rows:
            leg = row[idx["type"]].strip("*")
            out.append(f"### {leg}\n")
            out.append(f"- **Entry TF:** {row[idx['entry tf']]}")
            out.append(f"- **Trend / HTF TF:** {row[idx['trend / htf tf']]}")
            out.append(f"- **Real money:** {row[idx['real money']]}")
            out.append(f"- **Dry-run / backtest:** {row[idx['dry-run / backtest']]}")
            out.append("")
        return "\n".join(out).rstrip()

    # Parameter | Default | Unit | Kegunaan
    if n == 4 and norm[0] == "parameter" and norm[1] == "default" and norm[3] == "kegunaan":
        lines = []
        for row in rows:
            param = row[0].strip("`")
            lines.append(f"- **`{param}`:** {row[1]} ({row[2]}) — {row[3]}")
        return "\n".join(lines)

    # Parameter | Default | Unit (no kegunaan - tick open trade some docs)
    if n == 3 and norm[0] == "parameter" and norm[1] == "default" and norm[2] == "unit":
        lines = []
        for row in rows:
            param = row[0].strip("`")
            lines.append(f"- **`{param}`:** {row[1]} ({row[2]})")
        return "\n".join(lines)

    # Parameter | Default | Kegunaan (3 col)
    if n == 3 and norm[0] == "parameter" and norm[1] == "default":
        lines = []
        for row in rows:
            param = row[0].strip("`")
            lines.append(f"- **`{param}`:** {row[1]} — {row[2]}")
        return "\n".join(lines)

    # Parameter | Default | Efek
    if n == 3 and norm[0] == "parameter" and norm[2] in ("efek", "efek jika `true`"):
        lines = []
        for row in rows:
            param = row[0].strip("`")
            lines.append(f"- **`{param}`:** {row[1]} — {row[2]}")
        return "\n".join(lines)

    # Leg | Key overrides / Overrides
    if norm[0] == "leg" and norm[1] in ("key overrides", "overrides"):
        lines = []
        for row in rows:
            leg = row[0].strip("*")
            lines.append(f"- **{leg}:** {row[1]}")
        return "\n".join(lines)

    # Model | Extra checklist layers
    if norm[0] == "model":
        lines = []
        for row in rows:
            lines.append(f"- **`{row[0]}`:** {row[1]}")
        return "\n".join(lines)

    # Zone | Window
    if norm[0] == "zone" and "window" in norm[1]:
        lines = []
        for row in rows:
            lines.append(f"- **`{row[0]}`:** {row[1]}")
        return "\n".join(lines)

    # Behavior | Default
    if norm[0] == "behavior" and norm[1] == "default":
        lines = []
        for row in rows:
            lines.append(f"- **{row[0]}:** {row[1]}")
        return "\n".join(lines)

    # Mode | Trigger / Behavior
    if norm[0] == "mode":
        lines = []
        for row in rows:
            lines.append(f"- **`{row[0]}`:** {row[1]}")
        return "\n".join(lines)

    # Stage | Effect (2 col gate funnel)
    if n == 2 and norm[0] == "stage" and norm[1] == "effect":
        lines = []
        for row in rows:
            lines.append(f"- **{row[0]}:** {row[1]}")
        return "\n".join(lines)

    # Stage | All legs
    if n == 2 and norm[0] == "stage" and norm[1] == "all legs":
        lines = []
        for row in rows:
            lines.append(f"- **{row[0]}:** {row[1]}")
        return "\n".join(lines)

    # Gate funnel: Stage | Scalping | Intraday | Swing (or variants)
    if norm[0] == "stage" and n >= 3:
        out = []
        leg_cols = headers[1:]
        for row in rows:
            out.append(f"### {row[0]}\n")
            for i, leg in enumerate(leg_cols, start=1):
                out.append(f"- **{leg.strip('*')}:** {row[i]}")
            out.append("")
        return "\n".join(out).rstrip()

    # Layer A entry signal: Leg | Entry TF | LONG | SHORT
    if norm[0] == "leg" and "long" in norm and "short" in norm:
        out = []
        idx = {normalize_header(h): i for i, h in enumerate(headers)}
        for row in rows:
            leg = row[idx["leg"]].strip("*")
            out.append(f"### {leg}\n")
            if "entry tf" in idx:
                out.append(f"- **Entry TF:** {row[idx['entry tf']]}")
            out.append(f"- **LONG:** {row[idx['long']]}")
            out.append(f"- **SHORT:** {row[idx['short']]}")
            out.append("")
        return "\n".join(out).rstrip()

    # Pattern | Swing | Direction | reason
    if norm[0] == "pattern" and "direction" in norm:
        out = []
        idx = {normalize_header(h): i for i, h in enumerate(headers)}
        for row in rows:
            out.append(f"### {row[idx['pattern']]}\n")
            for key in ["swing", "direction", "reason"]:
                if key in idx:
                    label = key.capitalize() if key != "reason" else "`reason`"
                    if key == "reason":
                        label = "`reason`"
                    else:
                        label = key.capitalize()
                    out.append(f"- **{label}:** {row[idx[key]]}")
            out.append("")
        return "\n".join(out).rstrip()

    # Label | Emitted when | Code condition
    if norm[0] == "label" and "emitted when" in norm:
        lines = []
        for row in rows:
            label = strip_md_bold(row[0])
            if len(row) >= 3 and row[2]:
                lines.append(f"- **{label}:** {row[1]} — {row[2]}")
            else:
                lines.append(f"- **{label}:** {row[1]}")
        return "\n".join(lines)

    # Label | Emitted when (2 col)
    if norm[0] == "label" and norm[1] == "emitted when":
        lines = []
        for row in rows:
            lines.append(f"- **{strip_md_bold(row[0])}:** {row[1]}")
        return "\n".join(lines)

    # Label | Condition
    if norm[0] == "label" and norm[1] == "condition":
        lines = []
        for row in rows:
            lines.append(f"- **{strip_md_bold(row[0])}:** {row[1]}")
        return "\n".join(lines)

    # Side | Example labels / Typical labels
    if norm[0] == "side" or (norm[0] in ("side / pattern",) and "example" in norm[1].lower()):
        lines = []
        for row in rows:
            lines.append(f"- **{row[0]}:** {row[1]}")
        return "\n".join(lines)

    # Sequence step | Drives entry? | Signal label?
    if norm[0] == "sequence step":
        out = []
        for row in rows:
            out.append(f"### {row[0]}\n")
            out.append(f"- **Drives entry?:** {row[1]}")
            out.append(f"- **Signal label?:** {row[2]}")
            out.append("")
        return "\n".join(out).rstrip()

    # reason code table: reason | Direction | Condition
    if norm[0] == "`reason` code" or norm[0] == "reason code":
        out = []
        idx = {normalize_header(h): i for i, h in enumerate(headers)}
        for row in rows:
            reason = row[0].strip("`")
            out.append(f"### `{reason}`\n")
            if "direction" in idx:
                out.append(f"- **Direction:** {row[idx['direction']]}")
            if "condition" in idx:
                out.append(f"- **Condition:** {row[idx['condition']]}")
            out.append("")
        return "\n".join(out).rstrip()

    # Label | reason | Direction (TS_VP entry signal labels)
    if norm[0] == "label" and "reason" in norm[1]:
        lines = []
        idx = {normalize_header(h): i for i, h in enumerate(headers)}
        for row in rows:
            label = strip_md_bold(row[0])
            parts = []
            if "reason" in idx:
                parts.append(f"`{row[idx['reason']]}`")
            if "direction" in idx and row[idx["direction"]] not in ("—", "-", ""):
                parts.append(row[idx["direction"]])
            suffix = f" — {', '.join(parts)}" if parts else ""
            lines.append(f"- **{label}:**{suffix}")
        return "\n".join(lines)

    # Side | Typical labels (MARKET_STRUCTURE)
    if norm[0] == "side" and "typical labels" in norm[1]:
        lines = []
        for row in rows:
            lines.append(f"- **{row[0]}:** {row[1]}")
        return "\n".join(lines)

    # Intraday detector modes: Mode | Behavior
    if norm[0] == "mode" and norm[1] == "behavior":
        lines = []
        for row in rows:
            lines.append(f"- **`{row[0]}`:** {row[1]}")
        return "\n".join(lines)

    # Fallback: 2-column key-value
    if n == 2:
        lines = []
        for row in rows:
            lines.append(f"- **{row[0]}:** {row[1]}")
        return "\n".join(lines)

    # Fallback: keep as-is with warning
    print(f"WARNING: unhandled table {norm} in context '{context[:60]}'", file=sys.stderr)
    return None


def convert_file(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    out = []
    i = 0
    changed = False

    while i < len(lines):
        line = lines[i]
        if line.strip().startswith("|") and i + 1 < len(lines) and is_separator_row(lines[i + 1]):
            # gather table
            table_lines = [line]
            i += 1
            table_lines.append(lines[i])  # separator
            i += 1
            while i < len(lines) and lines[i].strip().startswith("|"):
                table_lines.append(lines[i])
                i += 1

            headers = parse_table_row(table_lines[0])
            rows = [parse_table_row(r) for r in table_lines[2:]]
            context = "".join(out[-3:]) if out else path.name
            converted = convert_table(headers, rows, context)
            if converted is None:
                out.extend(table_lines)
            else:
                out.append(converted + "\n")
                changed = True
            continue

        out.append(line)
        i += 1

    if changed:
        path.write_text("".join(out), encoding="utf-8")
    return changed


def main():
    docs_dir = Path(__file__).resolve().parents[1] / "docs"
    for name in DOCS:
        p = docs_dir / name
        if not p.exists():
            print(f"MISSING: {p}", file=sys.stderr)
            continue
        ok = convert_file(p)
        print(f"{'converted' if ok else 'unchanged'}: {name}")


if __name__ == "__main__":
    main()
