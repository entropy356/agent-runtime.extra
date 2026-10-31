"""A DeepSeek-harness-like front end for the emotion/memory runtime.

One process, one port. Chat on top, the runtime's own run chain underneath, folded
by default. Each conversation is its own database. There is no delete endpoint:
threads can be created and continued, never removed from here.

The runtime package is imported, not modified; it lives in a sibling checkout:
    AGENT_RUNTIME_PATH  default ../agent-runtime/demos/demo1-emotion-memory
"""
import json
import math
import os
import re
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE = Path(__file__).resolve().parent
DATA = BASE / "data"
DATA.mkdir(exist_ok=True)

RUNTIME_PATH = os.environ.get("AGENT_RUNTIME_PATH") or str(
    BASE.parent / "agent-runtime" / "demos" / "demo1-emotion-memory")
sys.path.insert(0, RUNTIME_PATH)

from agent_runtime.providers import APIProvider  # noqa: E402
from agent_runtime.runtime import Runtime  # noqa: E402

PROVIDER = APIProvider()
CURRENT = threading.local()
SESSIONS = {}
RUNS = {}
LOCK = threading.RLock()


# ---------------------------------------------------------------- instrumentation
class Tracer:
    """Collects what the runtime did while a step ran. Timing and payloads only:
    it reads the provider's structured result, never a raw reasoning stream."""

    PHASES = {"cognize_start": "模型认知", "cognition": "校验结果",
              "recall_request": "要求再检索", "embed": "嵌入输入"}

    def __init__(self, run, limit=200):
        self.run, self.limit = run, limit
        self.sink = run["events"]
        self.t0 = time.perf_counter()

    def emit(self, kind, **fields):
        if len(self.sink) >= self.limit:
            return
        self.sink.append({"seq": len(self.sink) + 1,
                          "at": round(time.perf_counter() - self.t0, 3),
                          "kind": kind, **fields})
        phase = self.PHASES.get(kind)
        if kind == "embed" and fields.get("task") != "query":
            phase = "写入记忆"
        if phase:
            self.run["phase"] = phase


class Instrumented:
    """Pass-through provider that notes call boundaries and results."""

    def __init__(self, inner):
        self.inner = inner
        self.mode = inner.mode
        self.profile = inner.profile

    def embed(self, text, task=None):
        tracer = getattr(CURRENT, "tracer", None)
        started = time.perf_counter()
        vector = self.inner.embed(text, task)
        if tracer:
            tracer.emit("embed", task=task or "plain", dim=len(vector),
                        ms=int((time.perf_counter() - started) * 1000))
        return vector

    def cognize(self, text, memories, recall_left=0, library_size=None):
        tracer = getattr(CURRENT, "tracer", None)
        if tracer:
            tracer.emit("cognize_start", context_ids=[m["id"] for m in memories],
                        recall_left=recall_left, library_size=library_size)
        started = time.perf_counter()
        result = self.inner.cognize(text, memories, recall_left, library_size)
        if tracer:
            asked = isinstance(result, dict) and "recall" in result
            tracer.emit("recall_request" if asked else "cognition",
                        ms=int((time.perf_counter() - started) * 1000),
                        payload=result if asked else {k: result.get(k) for k in
                                                      ("answer", "appraisal", "used_memory_ids", "memories")})
        return result


PROVIDER = Instrumented(PROVIDER)


# ---------------------------------------------------------------- slim projections
MEMORY_FIELDS = ("id", "content", "appraisal", "created_step", "origin", "uses",
                 "write_strength", "relevance", "emotion_match", "read_strength",
                 "score", "selected", "selected_by", "usage_frequency", "replaces",
                 "source_memory_ids")


def slim_rows(rows):
    out = []
    for row in rows or []:
        item = {k: row.get(k) for k in MEMORY_FIELDS if k in row}
        for key in ("write_strength", "relevance", "emotion_match", "read_strength", "score"):
            if isinstance(item.get(key), float):
                item[key] = round(item[key], 4)
        out.append(item)
    return out


def emotion_note(before, after):
    def norm(vector):
        return round(math.sqrt(sum(v * v for v in vector)), 4) if vector else None
    drift = None
    if before and after:
        dot = sum(a * b for a, b in zip(before, after))
        n = (norm(before) or 0) * (norm(after) or 0)
        drift = round(max(0.0, 1 - dot / n), 4) if n else None
    return {"from_norm": norm(before), "to_norm": norm(after), "drift": drift}


def slim_trace(trace, memories=()):
    """Everything the viewer shows, without the vectors."""
    cognition = dict(trace["cognition"])
    written = [m for m in memories if m["id"] in trace["written_ids"]]
    return {
        "step": trace["step"],
        "input": trace["input"],
        "enabled": trace["enabled"],
        "rho": trace["rho"],
        "usage_window": trace["usage_window"],
        "recall_limit": trace["recall_limit"],
        "mode": trace["mode"],
        "emotion": emotion_note(trace["emotion_before"], trace["emotion_after"]),
        "retrieval": slim_rows(trace["retrieval"]),
        "recalls": [{"query": r["query"], "rows": slim_rows(r["rows"])} for r in trace["recalls"]],
        "cognition": cognition,
        "written": slim_rows(written),
        "written_ids": trace["written_ids"],
        "replaced_ids": trace["replaced_ids"],
    }


# ---------------------------------------------------------------- sessions
class Session:
    def __init__(self, sid, meta):
        self.id, self.meta = sid, meta
        self.db, self.meta_path = DATA / f"{sid}.sqlite3", DATA / f"{sid}.json"
        self.lock = threading.RLock()
        self._runtime = None
        self.running = False
        self.active = None
        self.cached = None

    @property
    def runtime(self):
        with self.lock:
            if self._runtime is None:
                self._runtime = Runtime(self.db, PROVIDER, 0.85, 2)
            return self._runtime

    def save_meta(self):
        tmp = self.meta_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.meta, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.meta_path)

    def snapshot(self):
        # Reading the database mid-step would queue behind the write transaction.
        if self.running:
            # Mid-step: last committed numbers, never a blocking read.
            if self.cached:
                return self.cached
            if "step" in self.meta:
                return {"step": self.meta["step"], "library": self.meta.get("library", 0),
                        "memories": []}
            return {"step": 0, "library": 0, "memories": []}
        state = self.runtime.inspect()["state"]
        self.cached = {"step": state["step"], "library": len(state["memories"]),
                       "memories": slim_rows(state["memories"])}
        return self.cached

    def summary(self):
        last = next((m for m in reversed(self.meta["messages"]) if m["role"] == "user"), None)
        return {"id": self.id, "title": self.meta["title"], "created": self.meta["created"],
                "messages": len(self.meta["messages"]),
                "preview": (last or {}).get("text", "")[:60],
                "turns": self.meta.get("turns", 0)}


def load_sessions():
    for path in DATA.glob("*.json"):
        sid = path.stem
        if sid in SESSIONS:
            continue
        try:
            meta = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        SESSIONS[sid] = Session(sid, meta)


def get_session(sid):
    with LOCK:
        session = SESSIONS.get(sid)
        if session is None and (DATA / f"{sid}.json").exists():
            session = SESSIONS[sid] = Session(sid, json.loads((DATA / f"{sid}.json").read_text()))
        return session


def new_session():
    sid = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]
    meta = {"id": sid, "title": "新对话", "created": time.time(), "messages": [], "turns": 0}
    session = Session(sid, meta)
    session.save_meta()
    with LOCK:
        SESSIONS[sid] = session
    return session


# ---------------------------------------------------------------- runs
def start_run(session, text):
    run_id = uuid.uuid4().hex[:12]
    run = {"id": run_id, "status": "running", "phase": "准备", "events": [],
           "answer": None, "trace": None, "error": None,
           "started": time.time(), "elapsed": None}
    with LOCK:
        RUNS[(session.id, run_id)] = run
    session.active = run_id

    def work():
        with session.lock:
            session.running = True
            tracer = Tracer(run)
            CURRENT.tracer = tracer
            try:
                run["phase"] = "读取状态"
                trace = session.runtime.step(text)
                state = session.runtime.inspect()["state"]
                session.cached = {"step": state["step"], "library": len(state["memories"]),
                                  "memories": slim_rows(state["memories"])}
                run["trace"] = slim_trace(trace, state["memories"])
                run["answer"] = trace["cognition"]["answer"]
                run["status"] = "done"
                run["elapsed"] = round(time.perf_counter() - tracer.t0, 3)
                session.meta["messages"].append({
                    "role": "assistant", "run": run_id, "answer": run["answer"],
                    "trace": run["trace"], "events": run["events"],
                    "elapsed": run["elapsed"], "error": None, "at": time.time()})
                session.meta["turns"] = session.meta.get("turns", 0) + 1
                session.meta["step"] = state["step"]
                session.meta["library"] = len(state["memories"])
                session.save_meta()
            except Exception as error:  # surfaced to the viewer, never hidden
                run["status"] = "error"
                run["error"] = str(error) or error.__class__.__name__
                run["elapsed"] = round(time.perf_counter() - tracer.t0, 3)
                session.meta["messages"].append({
                    "role": "assistant", "run": run_id, "answer": None, "trace": None,
                    "events": run["events"], "elapsed": run["elapsed"],
                    "error": run["error"], "at": time.time()})
                session.save_meta()
            finally:
                session.running = False
                session.active = None
                CURRENT.tracer = None

    threading.Thread(target=work, daemon=True).start()
    return run


# ---------------------------------------------------------------- http
THREADS = re.compile(r"^/api/threads/([\w.-]+)$")
MESSAGES = re.compile(r"^/api/threads/([\w.-]+)/messages$")
RUN = re.compile(r"^/api/threads/([\w.-]+)/runs/([\w.-]+)$")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, content_type):
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        size = int(self.headers.get("Content-Length") or 0)
        if not 0 < size <= 20000:
            raise ValueError("请求体为空或过大")
        data = json.loads(self.rfile.read(size))
        if not isinstance(data, dict):
            raise ValueError("请求必须是对象")
        return data

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            return self.send_file(BASE / "static" / "index.html", "text/html; charset=utf-8")
        if path == "/static/app.js":
            return self.send_file(BASE / "static" / "app.js", "text/javascript; charset=utf-8")
        if path == "/static/style.css":
            return self.send_file(BASE / "static" / "style.css", "text/css; charset=utf-8")
        if path == "/api/threads":
            load_sessions()
            with LOCK:
                items = sorted((s.summary() for s in SESSIONS.values()),
                               key=lambda item: item["created"], reverse=True)
            return self.send_json(200, {"threads": items, "mode": PROVIDER.mode,
                                        "profile": PROVIDER.profile})
        match = THREADS.match(path)
        if match:
            session = get_session(match.group(1))
            if session is None:
                return self.send_json(404, {"error": "会话不存在"})
            return self.send_json(200, {
                "id": session.id, "title": session.meta["title"],
                "messages": session.meta["messages"], "running": session.running,
                "active": session.active, "state": session.snapshot()})
        match = RUN.match(path)
        if match:
            run = RUNS.get((match.group(1), match.group(2)))
            if run is None:
                return self.send_json(404, {"error": "运行记录不存在"})
            snapshot = {**run, "events": list(run["events"]),
                        "now": round(time.time() - run["started"], 3) if run["status"] == "running"
                        else run["elapsed"]}
            return self.send_json(200, snapshot)
        return self.send_json(404, {"error": "没有这个地址"})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        try:
            if path == "/api/threads":
                session = new_session()
                return self.send_json(200, {"id": session.id, "title": session.meta["title"]})
            match = MESSAGES.match(path)
            if match:
                session = get_session(match.group(1))
                if session is None:
                    return self.send_json(404, {"error": "会话不存在"})
                data = self.body()
                text = data.get("text")
                if not isinstance(text, str) or not text.strip() or len(text) > 2000:
                    raise ValueError("消息需为 1–2000 字符的文本")
                if session.running:
                    return self.send_json(409, {"error": "这一轮还没结束"})
                with session.lock:
                    if not session.meta["messages"]:
                        session.meta["title"] = text.strip()[:24]
                    session.meta["messages"].append({"role": "user", "text": text.strip(),
                                                     "at": time.time()})
                    session.save_meta()
                run = start_run(session, text.strip())
                return self.send_json(200, {"run": run["id"], "thread": session.id})
            if path.startswith("/api/"):
                # No delete endpoint by design: a thread's database is not removed from here.
                return self.send_json(404, {"error": "没有这个地址"})
            return self.send_json(404, {"error": "没有这个地址"})
        except (ValueError, json.JSONDecodeError) as error:
            return self.send_json(400, {"error": str(error)})
        except Exception as error:
            return self.send_json(500, {"error": f"操作失败：{error.__class__.__name__}"})

    def do_DELETE(self):
        # Explicitly unsupported. Deleting a conversation would delete its database.
        self.send_json(405, {"error": "这里不提供删除。会话只能新建和继续。"})

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    load_sessions()
    port = int(os.environ.get("PORT", "8090"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.daemon_threads = True
    print(f"harness on 0.0.0.0:{port} [{PROVIDER.mode}] runtime={RUNTIME_PATH}", flush=True)
    server.serve_forever()
