#!/usr/bin/env python3
"""derive_expected - the expected outcome of each conformance stream, written independently of the
adapters, from the mapping in CASES.md, in another language, by different means: paths are found by
splitting the input into shell words, not by the adapters' patterns. Where the two disagree, a case
fails and the disagreement is resolved by reading CASES.md, not by copying either side.

Run-dependent fields - seconds, each trace event's time, the events path - are left out; the
workspace and home an invocation will have are written as ${WORKSPACE} and ${HOME}.

Usage: python3 derive_expected.py   (rewrites streams/*.expected.json)
"""
import json, os, posixpath, re, glob

HERE = os.path.dirname(os.path.abspath(__file__))
ADDRESS = re.compile(r'https?://[^\s"\'`<>)\]\\]+')
SPLIT = re.compile(r'[\s;|&<>()\'"`,=]+')
WS, HOME = "${WORKSPACE}", "${HOME}"


def strings(v):
    if isinstance(v, str):
        yield v
    elif isinstance(v, dict):
        for x in v.values():
            yield from strings(x)
    elif isinstance(v, list):
        for x in v:
            yield from strings(x)


def addresses(inp):
    out = []
    for s in strings(inp):
        for m in ADDRESS.findall(s):
            m = m.rstrip(".,;:")
            if m not in out:
                out.append(m)
    return out


def paths(inp):
    out = []
    for s in strings(inp):
        s = ADDRESS.sub(" ", s)
        for t in SPLIT.split(s):
            t = t.rstrip(".,;:")
            if t.startswith("/"):
                p = posixpath.normpath(t)
            elif t.startswith("~/"):
                p = HOME + "/" + posixpath.normpath(t[2:])
            elif t.startswith("../") or "/../" in t:
                p = WS + "/" + posixpath.normpath(t)
            else:
                continue
            if p not in out:
                out.append(p)
    return out


def cause(name, message):
    if name == "ContentFilterError" or re.search(r"content filter|blocked by the provider", message, re.I):
        return "filter"
    if re.search(r"context (window|length)|maximum context|too many tokens|prompt is too long", message, re.I):
        return "overflow"
    if name in ("APIError", "UnknownError") or re.search(r"\b[45]\d\d\b|bad request|rate limit|unavailable", message, re.I):
        return "provider"
    return "unknown"


def opencode(evs):
    texts, order, tools, trace = {}, [], [], []
    tin = tcache = tout = 0
    saw = False
    open_model = False
    filtered = False
    error = None
    session = None
    for e in evs:
        session = session or e.get("sessionID")
        p = e.get("part") or {}
        t = e.get("type")
        if t == "step_start":
            open_model = True
            trace.append({"kind": "model-start"})
        elif t == "step_finish":
            open_model = False
            k = p.get("tokens")
            if k:
                saw = True
                c = k.get("cache") or {}
                tin += k.get("input", 0) + c.get("write", 0) + c.get("read", 0)
                tcache += c.get("read", 0)
                tout += k.get("output", 0) + k.get("reasoning", 0)
            if p.get("reason") == "content-filter":
                filtered = True
            trace.append({"kind": "model-end", "reason": p.get("reason")})
        elif t == "text":
            mid = p.get("messageID")
            if mid is not None and isinstance(p.get("text"), str):
                if mid not in texts:
                    order.append(mid)
                    texts[mid] = ""
                texts[mid] += p["text"]
            trace.append({"kind": "text", "message": mid})
        elif t == "tool_use":
            st = p.get("state") or {}
            inp = st.get("input", {})
            s = st.get("status")
            status = "completed" if s == "completed" else ("declined" if re.search(r"rejected|prevents you|denied|not allowed", str(st.get("error")), re.I) else "error") if s == "error" else "running"
            tools.append({"name": p.get("tool", ""), "input": inp, "status": status, "paths": paths(inp), "addresses": addresses(inp)})
            trace.append({"kind": "tool-end", "tool": p.get("tool", ""), "status": status})
        elif t == "error":
            er = e.get("error") or {}
            name, msg = er.get("name", ""), (er.get("data") or {}).get("message", "")
            c = cause(name, msg)
            filtered = filtered or c == "filter"
            error = error or {"cause": c, "name": name, "message": msg}
            trace.append({"kind": "error", "cause": c, "name": name})
    return {
        "final": texts[order[-1]] if order else "",
        "inFlight": "model" if open_model else "none",
        "tokens": [tin, tcache, tout] if saw else [None, None, None],
        "tools": tools, "filtered": filtered, "error": error, "session": session, "trace": trace,
    }


def codex(evs):
    tools, keys, trace = {}, [], []
    final = ""
    tin = tcache = tout = 0
    saw = False
    open_model = False
    error = None
    session = None

    def fail(msg):
        nonlocal error
        c = cause("", msg)
        error = error or {"cause": c, "name": "", "message": msg}
        trace.append({"kind": "error", "cause": c})

    for e in evs:
        t = e.get("type")
        if t == "thread.started":
            session = session or e.get("thread_id")
        elif t == "turn.started":
            open_model = True
            trace.append({"kind": "model-start"})
        elif t == "turn.completed":
            open_model = False
            u = e.get("usage")
            if u:
                saw = True
                tin += u.get("input_tokens", 0)
                tcache += u.get("cached_input_tokens", 0)
                tout += u.get("output_tokens", 0)
            trace.append({"kind": "model-end"})
        elif t == "turn.failed":
            open_model = False
            trace.append({"kind": "model-end"})
            fail((e.get("error") or {}).get("message") or e.get("message") or "")
        elif t == "error":
            fail(e.get("message") or (e.get("error") or {}).get("message") or "")
        elif t in ("item.started", "item.completed"):
            it = e.get("item") or {}
            done = t == "item.completed"
            ty = it.get("type")
            if ty == "agent_message" and done:
                final = it.get("text", "")
                trace.append({"kind": "text", "item": it.get("id")})
            elif ty == "error" and done:
                fail(it.get("message", ""))
            elif ty in ("command_execution", "file_change", "web_search", "mcp_tool_call", "collab_tool_call"):
                if ty == "command_execution":
                    inp = it.get("command", "")
                elif ty == "file_change":
                    inp = [c.get("path", "") for c in it.get("changes", [])]
                elif ty == "web_search":
                    a = it.get("action") or {}
                    inp = {"query": it.get("query", a.get("query")), "url": a.get("url")}
                else:
                    inp = {k: v for k, v in it.items() if k not in ("id", "type", "status")}
                if not done:
                    status = "running"
                elif it.get("status") == "failed" or (isinstance(it.get("exit_code"), int) and it.get("exit_code") != 0):
                    status = "error"
                elif it.get("status") == "declined":
                    status = "declined"
                else:
                    status = "completed"
                key = it.get("id", str(len(tools)))
                if key not in tools:
                    keys.append(key)
                tools[key] = {"name": ty, "input": inp, "status": status, "paths": paths(inp), "addresses": addresses(inp)}
                trace.append({"kind": "tool-end" if done else "tool-start", "tool": ty, "status": status})
    all_tools = [tools[k] for k in keys]
    return {
        "final": final,
        "inFlight": "tool" if any(x["status"] == "running" for x in all_tools) else ("model" if open_model else "none"),
        "tokens": [tin, tcache, tout] if saw else [None, None, None],
        "tools": all_tools, "filtered": False, "error": error, "session": session, "trace": trace,
    }


def expected(file):
    evs = []
    for line in open(file):
        try:
            evs.append(json.loads(line))
        except ValueError:
            pass
    d = codex(evs) if os.path.basename(file).startswith("codex") else opencode(evs)
    return {
        "final": d["final"], "exit": 0, "signal": None,
        "stop": {"reason": "error" if d["error"] else "completed", "inFlight": d["inFlight"]},
        "cost": {"inputTokens": d["tokens"][0], "cachedInputTokens": d["tokens"][1], "outputTokens": d["tokens"][2], "toolCalls": len(d["tools"])},
        "tools": d["tools"], "filtered": d["filtered"], "error": d["error"], "session": d["session"], "trace": d["trace"],
    }


if __name__ == "__main__":
    for f in sorted(glob.glob(os.path.join(HERE, "streams", "*.jsonl"))):
        out = f[:-len(".jsonl")] + ".expected.json"
        with open(out, "w") as fh:
            json.dump(expected(f), fh, indent=2, ensure_ascii=True)
            fh.write("\n")
        print(os.path.basename(out))
