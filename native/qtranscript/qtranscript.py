#!/usr/bin/env python3
"""render a claude code transcript (.jsonl) as readable markdown.

these files run to several MB of json with no line breaks inside a record, and
nothing reads them. this turns one into something you can actually scroll.

usage: qtranscript.py <file.jsonl> [--limit N] [--from N]
"""
import json
import sys
import datetime

SKIP = {
    "file-history-snapshot", "bridge-session", "atis-latch", "cost-state",
    "last-prompt", "mode", "permission-mode", "ai-title",
}


def ts(rec):
    t = rec.get("timestamp")
    if not t:
        return ""
    try:
        d = datetime.datetime.fromisoformat(t.replace("Z", "+00:00"))
        return d.astimezone().strftime("%H:%M:%S")
    except Exception:
        return ""


def text_of(msg):
    """a message's content is either a string or a list of typed blocks."""
    c = msg.get("content")
    if isinstance(c, str):
        return [("text", c)]
    out = []
    if isinstance(c, list):
        for b in c:
            if not isinstance(b, dict):
                continue
            t = b.get("type")
            if t == "text":
                out.append(("text", b.get("text", "")))
            elif t == "thinking":
                out.append(("thinking", b.get("thinking", "")))
            elif t == "tool_use":
                out.append(("tool_use", (b.get("name", "?"), b.get("input", {}))))
            elif t == "tool_result":
                r = b.get("content")
                if isinstance(r, list):
                    r = "\n".join(x.get("text", "") for x in r if isinstance(x, dict))
                out.append(("tool_result", (b.get("is_error", False), str(r or ""))))
    return out


def clip(s, n):
    s = s.rstrip()
    if len(s) <= n:
        return s
    return s[:n].rstrip() + "\n… [" + str(len(s) - n) + " more chars]"


def render(path, limit=None, start=0):
    lines = []
    title = None
    n = 0
    with open(path, "r", errors="replace") as fh:
        for raw in fh:
            try:
                rec = json.loads(raw)
            except Exception:
                continue
            t = rec.get("type")
            if t == "ai-title":
                title = rec.get("aiTitle")
                continue
            if t in SKIP:
                continue
            n += 1
            if n <= start:
                continue
            if limit and n > start + limit:
                lines.append("\n*[truncated. rerun with --from %d]*" % n)
                break

            when = ts(rec)
            if t == "user":
                msg = rec.get("message", {})
                for kind, val in text_of(msg):
                    if kind == "text" and val.strip():
                        lines.append("\n## you · %s\n\n%s" % (when, clip(val, 4000)))
                    elif kind == "tool_result":
                        err, body = val
                        head = "result" + (" (error)" if err else "")
                        lines.append("\n<details><summary>%s</summary>\n\n```\n%s\n```\n\n</details>"
                                     % (head, clip(body, 2000)))
            elif t == "assistant":
                msg = rec.get("message", {})
                model = msg.get("model", "")
                for kind, val in text_of(msg):
                    if kind == "text" and val.strip():
                        lines.append("\n## claude · %s  <sub>%s</sub>\n\n%s" % (when, model, clip(val, 4000)))
                    elif kind == "thinking" and val.strip():
                        lines.append("\n<details><summary>thinking</summary>\n\n%s\n\n</details>"
                                     % clip(val, 2000))
                    elif kind == "tool_use":
                        name, inp = val
                        brief = inp.get("command") or inp.get("file_path") or inp.get("pattern") \
                            or inp.get("description") or ""
                        lines.append("\n**→ %s** `%s`" % (name, clip(str(brief), 200).replace("\n", " ")))
            elif t == "system":
                sub = rec.get("subtype", "")
                if sub:
                    lines.append("\n*system: %s*" % sub)

    head = "# %s\n\n`%s`\n\n%d records\n" % (title or "session", path, n)
    return head + "\n".join(lines)


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a:
        sys.exit("usage: qtranscript.py <file.jsonl> [--limit N] [--from N]")
    path = a[0]
    limit = start = 0
    if "--limit" in a:
        limit = int(a[a.index("--limit") + 1])
    if "--from" in a:
        start = int(a[a.index("--from") + 1])
    sys.stdout.write(render(path, limit or None, start))
