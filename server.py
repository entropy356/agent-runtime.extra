"""One runtime, one harness.

demo1  emotion + memory      ../e-m-c/demos/demo1-emotion-memory

demo2（memory dynamics）随 codex/demo2-memory-dynamics 分支与 PR #7 删除，后端不再注册。

Chat on top, the runtime's own run chain folded underneath. Every conversation is
its own database. There is no delete endpoint: threads can be created and
continued, never removed from here.

Everything is also appended to logs/*.jsonl:
    runs.jsonl     one line per turn, with the full trace
    calls.jsonl    one line per provider call (embed / cognize), with timing
    ratings.jsonl  human score + note on an answer; never fed back to the runtime
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
LOG_DIR = BASE / "logs"
for folder in (DATA, LOG_DIR):
    folder.mkdir(exist_ok=True)

DEMO1_PATH = (os.environ.get("EMC_PATH")
              or os.environ.get("AGENT_RUNTIME_PATH")  # 旧变量名，仍然认
              or str(BASE.parent / "e-m-c" / "demos" / "demo1-emotion-memory"))
if DEMO1_PATH not in sys.path:
    sys.path.insert(0, DEMO1_PATH)

from emc.providers import APIProvider  # noqa: E402
from emc.runtime import Runtime as EmotionRuntime  # noqa: E402

# demo2 的代码随分支一起删了，这里降级为可选：没有 memory_dynamics 就只跑 demo1。
try:
    from memory_dynamics.model import DynamicsConfig  # noqa: E402
    from memory_dynamics.providers import APIProvider as DynamicsProvider  # noqa: E402
    from memory_dynamics.runtime import Runtime as DynamicsRuntime  # noqa: E402
    DYNAMICS_AVAILABLE = True
except ModuleNotFoundError:
    DYNAMICS_AVAILABLE = False
    DynamicsConfig = DynamicsProvider = DynamicsRuntime = None

CURRENT = threading.local()
SESSIONS = {}
RUNS = {}
LOCK = threading.RLock()

RUN_LOG = LOG_DIR / "runs.jsonl"
CALL_LOG = LOG_DIR / "calls.jsonl"
RATING_LOG = LOG_DIR / "ratings.jsonl"

BACKENDS = {
    "demo1": {"label": "情绪记忆", "data": DATA / "demo1"},
    "demo2": {"label": "记忆动力学", "data": DATA / "demo2"},
}
if not DYNAMICS_AVAILABLE:
    BACKENDS.pop("demo2", None)
for spec in BACKENDS.values():
    spec["data"].mkdir(exist_ok=True)


def append_log(path, record):
    line = json.dumps(record, ensure_ascii=False, allow_nan=False) + "\n"
    with LOCK:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line)


# ---------------------------------------------------------------- instrumentation
class Tracer:
    """Collects what the runtime did while a step ran. Timing and payloads only:
    it reads the provider's structured result, never a raw reasoning stream."""

    PHASES = {"cognize_start": "模型认知", "cognition": "校验结果",
              "recall_request": "要求再检索", "embed": "嵌入输入"}

    def __init__(self, run, thread, backend, limit=200):
        self.run, self.thread, self.backend = run, thread, backend
        self.limit = limit
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

    def call(self, kind, started, status, **fields):
        append_log(CALL_LOG, {
            "ts": round(time.time(), 3), "thread": self.thread, "run": self.run["id"],
            "backend": self.backend, "kind": kind,
            "ms": int((time.perf_counter() - started) * 1000),
            "status": status, **fields})


def _note(status, tracer, kind, started, **fields):
    if tracer:
        tracer.call(kind, started, status, **fields)


class InstrumentedEmotion:
    """Pass-through provider for demo1: notes call boundaries and results."""

    def __init__(self, inner):
        self.inner = inner
        self.mode = inner.mode
        self.profile = inner.profile

    def embed(self, text, task=None):
        tracer = getattr(CURRENT, "tracer", None)
        started = time.perf_counter()
        try:
            vector = self.inner.embed(text, task)
        except Exception as error:
            _note("error:" + error.__class__.__name__, tracer, "embed", started,
                  task=task or "plain", detail=str(error)[:200])
            raise
        if tracer:
            tracer.emit("embed", task=task or "plain", dim=len(vector),
                        ms=int((time.perf_counter() - started) * 1000))
            tracer.call("embed", started, "ok", task=task or "plain", dim=len(vector))
        return vector

    def cognize(self, text, memories, recall_left=0, library_size=None):
        tracer = getattr(CURRENT, "tracer", None)
        if tracer:
            tracer.emit("cognize_start", context_ids=[m["id"] for m in memories],
                        recall_left=recall_left, library_size=library_size)
        started = time.perf_counter()
        try:
            result = self.inner.cognize(text, memories, recall_left, library_size)
        except Exception as error:
            _note("error:" + error.__class__.__name__, tracer, "cognize", started,
                  context=len(memories), detail=str(error)[:200])
            raise
        if tracer:
            asked = isinstance(result, dict) and "recall" in result
            tracer.emit("recall_request" if asked else "cognition",
                        ms=int((time.perf_counter() - started) * 1000),
                        payload=result if asked else {k: result.get(k) for k in
                                                      ("answer", "appraisal", "used_memory_ids", "memories")})
            tracer.call("cognize", started, "ok", context=len(memories), recall=asked)
        return result


class InstrumentedDynamics:
    """Pass-through provider for demo2 (its cognize takes no recall budget)."""

    def __init__(self, inner):
        self.inner = inner
        self.mode = inner.mode
        self.profile = inner.profile

    @property
    def chat_profile(self):
        return getattr(self.inner, "chat_profile", None)

    def embed(self, text, task=None):
        tracer = getattr(CURRENT, "tracer", None)
        started = time.perf_counter()
        try:
            vector = self.inner.embed(text, task)
        except Exception as error:
            _note("error:" + error.__class__.__name__, tracer, "embed", started,
                  task=task or "plain", detail=str(error)[:200])
            raise
        if tracer:
            tracer.emit("embed", task=task or "plain", dim=len(vector),
                        ms=int((time.perf_counter() - started) * 1000))
            tracer.call("embed", started, "ok", task=task or "plain", dim=len(vector))
        return vector

    def cognize(self, text, memories):
        tracer = getattr(CURRENT, "tracer", None)
        if tracer:
            tracer.emit("cognize_start", context_ids=[m["id"] for m in memories],
                        recall_left=0, library_size=None)
        started = time.perf_counter()
        try:
            result = self.inner.cognize(text, memories)
        except Exception as error:
            _note("error:" + error.__class__.__name__, tracer, "cognize", started,
                  context=len(memories), detail=str(error)[:200])
            raise
        if tracer:
            tracer.emit("cognition", ms=int((time.perf_counter() - started) * 1000),
                        payload={k: result.get(k) for k in
                                 ("answer", "used_memory_ids", "memories")})
            tracer.call("cognize", started, "ok", context=len(memories))
        return result


PROVIDERS = {
    "demo1": InstrumentedEmotion(APIProvider()),
}
if DYNAMICS_AVAILABLE:
    PROVIDERS["demo2"] = InstrumentedDynamics(DynamicsProvider())


# ---------------------------------------------------------------- slim projections
EMOTION_FIELDS = ("id", "content", "appraisal", "created_step", "origin", "uses",
                  "write_strength", "relevance", "emotion_match", "read_strength",
                  "score", "selected", "selected_by", "usage_frequency", "replaces",
                  "source_memory_ids")

DYNAMICS_FIELDS = ("id", "content", "weight", "stability", "created_step",
                   "activated_count", "last_activated_step", "relevance", "score",
                   "selected", "weight_before", "weight_after",
                   "effective_decay_rate", "stability_before", "stability_after",
                   "stability_gain")

FLOAT_FIELDS = ("write_strength", "relevance", "emotion_match", "read_strength",
                "score", "weight", "stability", "weight_before", "weight_after",
                "effective_decay_rate", "stability_before", "stability_after",
                "stability_gain")


def slim(rows, fields):
    out = []
    for row in rows or []:
        item = {k: row.get(k) for k in fields if k in row}
        for key in FLOAT_FIELDS:
            if isinstance(item.get(key), float):
                item[key] = round(item[key], 4)
        out.append(item)
    return out


def slim_rows(rows):
    return slim(rows, EMOTION_FIELDS)


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


def slim_trace_dynamics(trace, memories=()):
    written = [m for m in memories if m["id"] in trace["written_ids"]]
    return {
        "step": trace["step"],
        "input": trace["input"],
        "mode": trace["mode"],
        "config": trace["config"],
        "decayed": slim(trace["decayed"], DYNAMICS_FIELDS),
        "retrieval": slim(trace["retrieval"], DYNAMICS_FIELDS),
        "cognition": trace["cognition"],
        "activated": slim(trace["activated"], DYNAMICS_FIELDS),
        "written": slim(written, DYNAMICS_FIELDS),
        "written_ids": trace["written_ids"],
    }


def emotion_note(before, after):
    def norm(vector):
        return round(math.sqrt(sum(v * v for v in vector)), 4) if vector else None
    drift = None
    if before and after:
        dot = sum(a * b for a, b in zip(before, after))
        n = (norm(before) or 0) * (norm(after) or 0)
        drift = round(max(0.0, 1 - dot / n), 4) if n else None
    return {"from_norm": norm(before), "to_norm": norm(after), "drift": drift}


# ---------------------------------------------------------------- sessions
class Session:
    def __init__(self, backend, sid, meta):
        self.backend = backend
        self.id, self.meta = sid, meta
        folder = BACKENDS[backend]["data"]
        self.db, self.meta_path = folder / f"{sid}.sqlite3", folder / f"{sid}.json"
        self.lock = threading.RLock()
        self._runtime = None
        self.running = False
        self.active = None
        self.cached = None

    @property
    def provider(self):
        return PROVIDERS[self.backend]

    @property
    def runtime(self):
        with self.lock:
            if self._runtime is None:
                if self.backend == "demo1":
                    self._runtime = EmotionRuntime(self.db, self.provider, 0.85, 2)
                else:
                    config = DynamicsConfig(mode=self.meta.get("mode", "two-state"))
                    self._runtime = DynamicsRuntime(self.db, self.provider, config)
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
        fields = EMOTION_FIELDS if self.backend == "demo1" else DYNAMICS_FIELDS
        self.cached = {"step": state["step"], "library": len(state["memories"]),
                       "memories": slim(state["memories"], fields)}
        return self.cached

    def summary(self):
        last = next((m for m in reversed(self.meta["messages"]) if m["role"] == "user"), None)
        rated = [m for m in self.meta["messages"] if m.get("rating")]
        return {"id": self.id, "backend": self.backend, "title": self.meta["title"],
                "created": self.meta["created"], "messages": len(self.meta["messages"]),
                "preview": (last or {}).get("text", "")[:60],
                "turns": self.meta.get("turns", 0),
                "ratings": len(rated),
                "mode": self.meta.get("mode")}


def load_sessions():
    for backend, spec in BACKENDS.items():
        for path in spec["data"].glob("*.json"):
            sid = path.stem
            if (backend, sid) in SESSIONS:
                continue
            try:
                meta = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            SESSIONS[(backend, sid)] = Session(backend, sid, meta)


def get_session(sid):
    with LOCK:
        for backend in BACKENDS:
            session = SESSIONS.get((backend, sid))
            if session is not None:
                return session
        for backend, spec in BACKENDS.items():
            path = spec["data"] / f"{sid}.json"
            if path.exists():
                session = SESSIONS[(backend, sid)] = Session(
                    backend, sid, json.loads(path.read_text(encoding="utf-8")))
                return session
        return None


def new_session(backend, mode=None):
    sid = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]
    meta = {"id": sid, "title": "新对话", "created": time.time(), "messages": [],
            "turns": 0, "backend": backend}
    if backend == "demo2":
        meta["mode"] = mode if mode in ("two-state", "weight-only") else "two-state"
    session = Session(backend, sid, meta)
    session.save_meta()
    with LOCK:
        SESSIONS[(backend, sid)] = session
    return session


# ---------------------------------------------------------------- runs
def start_run(session, text):
    run_id = uuid.uuid4().hex[:12]
    run = {"id": run_id, "status": "running", "phase": "准备", "events": [],
           "answer": None, "trace": None, "error": None, "backend": session.backend,
           "started": time.time(), "elapsed": None}
    with LOCK:
        RUNS[(session.id, run_id)] = run
    session.active = run_id

    def work():
        with session.lock:
            session.running = True
            tracer = Tracer(run, session.id, session.backend)
            CURRENT.tracer = tracer
            try:
                run["phase"] = "读取状态"
                trace = session.runtime.step(text)
                state = session.runtime.inspect()["state"]
                fields = EMOTION_FIELDS if session.backend == "demo1" else DYNAMICS_FIELDS
                session.cached = {"step": state["step"], "library": len(state["memories"]),
                                  "memories": slim(state["memories"], fields)}
                run["trace"] = (slim_trace(trace, state["memories"])
                                if session.backend == "demo1"
                                else slim_trace_dynamics(trace, state["memories"]))
                run["answer"] = trace["cognition"]["answer"]
                run["status"] = "done"
                run["elapsed"] = round(time.perf_counter() - tracer.t0, 3)
                session.meta["messages"].append({
                    "role": "assistant", "run": run_id, "backend": session.backend,
                    "answer": run["answer"], "trace": run["trace"],
                    "events": run["events"], "elapsed": run["elapsed"],
                    "error": None, "at": time.time()})
                session.meta["turns"] = session.meta.get("turns", 0) + 1
                session.meta["step"] = state["step"]
                session.meta["library"] = len(state["memories"])
                session.save_meta()
            except Exception as error:  # surfaced to the viewer, never hidden
                run["status"] = "error"
                run["error"] = str(error) or error.__class__.__name__
                run["elapsed"] = round(time.perf_counter() - tracer.t0, 3)
                session.meta["messages"].append({
                    "role": "assistant", "run": run_id, "backend": session.backend,
                    "answer": None, "trace": None, "events": run["events"],
                    "elapsed": run["elapsed"], "error": run["error"], "at": time.time()})
                session.save_meta()
            finally:
                append_log(RUN_LOG, {
                    "ts": round(time.time(), 3), "thread": session.id, "run": run_id,
                    "backend": session.backend, "step": (run["trace"] or {}).get("step"),
                    "input": text, "answer": run["answer"], "elapsed": run["elapsed"],
                    "status": run["status"], "error": run["error"],
                    "trace": run["trace"], "events": run["events"]})
                session.running = False
                session.active = None
                CURRENT.tracer = None

    threading.Thread(target=work, daemon=True).start()
    return run


# ---------------------------------------------------------------- ratings
def check_ratings(session, items):
    """Validate a batch without touching state. Returns {run: (message, rating)}."""
    if not isinstance(items, list) or not 1 <= len(items) <= 200:
        raise ValueError("一次请发送 1–200 条评分")
    targets = {}
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("每条评分需为对象")
        run = item.get("run")
        score = item.get("score")
        note = item.get("note") or ""
        if not isinstance(run, str) or not run:
            raise ValueError("缺少 run id")
        if run in targets:
            raise ValueError(f"同一轮只能有一条评分：{run}")
        if type(score) is not int or not 1 <= score <= 5:
            raise ValueError("评分需为 1–5 的整数")
        if not isinstance(note, str) or len(note) > 1000:
            raise ValueError("评价最多 1000 字")
        target = next((m for m in session.meta["messages"]
                       if m.get("role") == "assistant" and m.get("run") == run), None)
        if target is None:
            raise ValueError(f"没有这一轮：{run}")
        targets[run] = (target, {"score": score, "note": note.strip()})
    return targets


def question_before(messages, target):
    try:
        index = messages.index(target)
    except ValueError:
        return None
    for earlier in reversed(messages[:index]):
        if earlier.get("role") == "user":
            return earlier.get("text")
    return None


def apply_ratings(session, targets):
    """Write the batch, one log line per rating. History is append-only."""
    now = time.time()
    batch = uuid.uuid4().hex[:8]
    applied = {}
    with session.lock:
        for run, (target, rating) in targets.items():
            previous = target.get("rating") or {}
            entry = {**rating, "at": now}
            target["rating"] = entry
            applied[run] = entry
            append_log(RATING_LOG, {
                "ts": round(now, 3), "batch": batch, "thread": session.id,
                "run": run, "backend": session.backend,
                "step": (target.get("trace") or {}).get("step"),
                "input": question_before(session.meta["messages"], target),
                "answer": target.get("answer"),
                # A rewrite of an earlier judgement keeps both lines.
                "replaces_score": previous.get("score"),
                "replaces_note": previous.get("note"),
                **rating})
        session.save_meta()
    return applied, batch


# ---------------------------------------------------------------- http
THREADS = re.compile(r"^/api/threads/([\w.-]+)$")
MESSAGES = re.compile(r"^/api/threads/([\w.-]+)/messages$")
RUN = re.compile(r"^/api/threads/([\w.-]+)/runs/([\w.-]+)$")
RATING = re.compile(r"^/api/threads/([\w.-]+)/messages/([\w.-]+)/rating$")
RATINGS = re.compile(r"^/api/threads/([\w.-]+)/ratings$")
SEED = re.compile(r"^/api/threads/([\w.-]+)/seed$")
NOTHING = re.compile(r"^$")


def tail_jsonl(path, limit):
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8").splitlines()[-limit:]
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


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

    def send_text(self, text, content_type, filename=None):
        body = text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        size = int(self.headers.get("Content-Length") or 0)
        if not 0 < size <= 40000:
            raise ValueError("请求体为空或过大")
        data = json.loads(self.rfile.read(size))
        if not isinstance(data, dict):
            raise ValueError("请求必须是对象")
        return data

    def do_GET(self):
        path, _, query = self.path.partition("?")
        params = {}
        for part in query.split("&"):
            if "=" in part:
                key, value = part.split("=", 1)
                params[key] = value
        if path in ("/", "/index.html"):
            return self.send_file(BASE / "static" / "index.html", "text/html; charset=utf-8")
        if path == "/static/app.js":
            return self.send_file(BASE / "static" / "app.js", "text/javascript; charset=utf-8")
        if path == "/static/style.css":
            return self.send_file(BASE / "static" / "style.css", "text/css; charset=utf-8")
        if path == "/api/threads":
            load_sessions()
            backend = params.get("backend") or "demo1"
            if backend not in BACKENDS:
                return self.send_json(400, {"error": "没有这个后端"})
            with LOCK:
                items = sorted((s.summary() for (b, _), s in SESSIONS.items() if b == backend),
                               key=lambda item: item["created"], reverse=True)
            provider = PROVIDERS[backend]
            return self.send_json(200, {"threads": items, "backend": backend,
                                        "mode": provider.mode, "profile": provider.profile,
                                        "label": BACKENDS[backend]["label"]})
        if path == "/api/logs":
            try:
                limit = max(1, min(300, int(params.get("limit", "40"))))
            except ValueError:
                limit = 40
            runs = tail_jsonl(RUN_LOG, limit)
            summary = [{
                "ts": row.get("ts"), "thread": row.get("thread"), "run": row.get("run"),
                "backend": row.get("backend"), "step": row.get("step"),
                "input": (row.get("input") or "")[:120],
                "answer": (row.get("answer") or "")[:200],
                "elapsed": row.get("elapsed"), "status": row.get("status"),
                "error": row.get("error"),
                "used": ((row.get("trace") or {}).get("cognition") or {}).get("used_memory_ids"),
            } for row in runs]
            ratings = {}
            for row in tail_jsonl(RATING_LOG, 500):
                ratings[(row.get("thread"), row.get("run"))] = row
            for row in summary:
                hit = ratings.get((row["thread"], row["run"]))
                if hit:
                    row["rating"] = {"score": hit.get("score"), "note": hit.get("note")}
            return self.send_json(200, {"runs": summary, "log": str(RUN_LOG),
                                        "calls": len(tail_jsonl(CALL_LOG, 100000))})
        if path == "/api/logs/export":
            text = ""
            for file in (RUN_LOG, CALL_LOG, RATING_LOG):
                if file.exists():
                    text += file.read_text(encoding="utf-8")
            return self.send_text(text, "application/x-ndjson; charset=utf-8",
                                  "harness-logs.jsonl")
        match = THREADS.match(path)
        if match:
            session = get_session(match.group(1))
            if session is None:
                return self.send_json(404, {"error": "会话不存在"})
            return self.send_json(200, {
                "id": session.id, "title": session.meta["title"], "backend": session.backend,
                "mode": session.meta.get("mode"),
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
                data = self.body()
                backend = data.get("backend") or "demo1"
                if backend not in BACKENDS:
                    raise ValueError("没有这个后端")
                session = new_session(backend, data.get("mode"))
                return self.send_json(200, {"id": session.id, "title": session.meta["title"],
                                            "backend": backend, "mode": session.meta.get("mode")})
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
            match = RATINGS.match(path)
            if match:
                session = get_session(match.group(1))
                if session is None:
                    return self.send_json(404, {"error": "会话不存在"})
                items = self.body().get("ratings")
                targets = check_ratings(session, items)
                applied, batch = apply_ratings(session, targets)
                return self.send_json(200, {"ratings": applied, "batch": batch})
            match = RATING.match(path)
            if match:
                session = get_session(match.group(1))
                if session is None:
                    return self.send_json(404, {"error": "会话不存在"})
                data = self.body()
                run = match.group(2)
                targets = check_ratings(session, [{"run": run, "score": data.get("score"),
                                                   "note": data.get("note")}])
                applied, batch = apply_ratings(session, targets)
                return self.send_json(200, {"rating": applied[run], "batch": batch})
            match = SEED.match(path)
            if match:
                session = get_session(match.group(1))
                if session is None:
                    return self.send_json(404, {"error": "会话不存在"})
                if session.backend != "demo2":
                    raise ValueError("只有记忆动力学后端支持初始化记忆")
                contents = self.body().get("contents")
                if not isinstance(contents, list) or not contents:
                    raise ValueError("请给出至少一条记忆")
                result = session.runtime.initialize(contents)
                append_log(LOG_DIR / "seeds.jsonl", {
                    "ts": round(time.time(), 3), "thread": session.id,
                    "backend": session.backend, **result})
                return self.send_json(200, result)
            if path.startswith("/api/"):
                # No delete endpoint by design: a thread's database is not removed from here.
                return self.send_json(404, {"error": "没有这个地址"})
            return self.send_json(404, {"error": "没有这个地址"})
        except (ValueError, json.JSONDecodeError) as error:
            return self.send_json(400, {"error": str(error)})
        except Exception as error:
            return self.send_json(500, {"error": f"操作失败：{error.__class__.__name__}：{error}"})

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
    print(f"harness on 0.0.0.0:{port} [{PROVIDERS['demo1'].mode}] "
          f"demo1={DEMO1_PATH}", flush=True)
    server.serve_forever()
