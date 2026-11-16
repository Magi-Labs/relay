#!/usr/bin/env python3
"""Relay's dependency-free host backend and CLI. One process per connected host."""
import argparse
import concurrent.futures
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from urllib.parse import urlsplit, unquote

VERSION = "0.4.0"
DEFAULT_PREFERENCES = {
    "theme": "graphite", "accent": "mint", "font_family": "system",
    "font_size": 13, "line_height": 1.35, "terminal_padding": 18,
    "cursor_style": "bar", "cursor_blink": True, "density": "comfortable",
    "left_width": 224, "right_width": 320, "show_workspaces": True,
    "show_repos": True, "show_timing": False,
}


AGENT_COMMANDS = {"claude": "claude", "codex": "codex", "gemini": "gemini", "opencode": "opencode", "aider": "aider", "amp": "amp", "droid": "droid", "copilot": "copilot", "cursor-agent": "cursor", "pi": "pi"}

def agent_command(command):
    """Inspect executable/script identity, never arbitrary prompt arguments or terminal text."""
    try: argv = shlex.split(command)
    except ValueError: return None
    if not argv: return None
    binary = Path(argv[0]).name
    if binary in AGENT_COMMANDS: return AGENT_COMMANDS[binary]
    if "/claude/versions/" in argv[0]: return "claude"
    if binary in ("node", "nodejs", "bun", "deno") or re.fullmatch(r"python[0-9.]*", binary):
        if len(argv) > 2 and argv[1] == "-m" and argv[2] in ("aider", "aider.main"): return "aider"
        if len(argv) < 2 or argv[1].startswith("-"): return None
        script = argv[1]
        stem = Path(script).name.removesuffix(".js").removesuffix(".mjs").removesuffix(".py")
        if stem in AGENT_COMMANDS: return AGENT_COMMANDS[stem]
        packages = {"@anthropic-ai/claude-code/":"claude", "@openai/codex/":"codex", "@google/gemini-cli/":"gemini", "opencode-ai/":"opencode", "@sourcegraph/amp/":"amp", "@github/copilot/":"copilot", "@mariozechner/pi-coding-agent/":"pi"}
        return next((agent for package, agent in packages.items() if "/" + package in script), None)
    return None

def foreground_agents(panes, process_table, terminals):
    processes, children = {}, {}
    for line in process_table.splitlines():
        fields = line.strip().split(None, 4)
        if len(fields) != 5: continue
        try: pid, ppid, pgid, foreground = map(int, fields[:4])
        except ValueError: continue
        processes[pid] = (pgid, foreground, fields[4])
        children.setdefault(ppid, []).append(pid)
    result = {t["id"]: None for t in terminals}
    for line in panes.splitlines():
        fields = line.split("\t")
        if len(fields) != 2 or not fields[0].startswith(("relay-", "magi-")): continue
        tid = fields[0].split("-", 1)[1]
        if tid not in result: continue
        try: root = int(fields[1])
        except ValueError: continue
        foreground = processes.get(root, (0, 0, ""))[1]
        queue, seen = [root], set()
        while queue and len(seen) < 10000:
            pid = queue.pop(0)
            if pid in seen: continue
            seen.add(pid)
            process = processes.get(pid)
            if process and foreground > 0 and process[0] == foreground:
                agent = agent_command(process[2])
                if agent:
                    result[tid] = agent
                    break
            queue.extend(children.get(pid, []))
    return result


def validate_preferences(values):
    if not isinstance(values, dict): raise ValueError("Preferences must be an object")
    enums = {"theme": ("graphite", "ocean", "dusk", "paper"), "accent": ("mint", "blue", "violet", "amber"),
             "font_family": ("system", "menlo", "jetbrains"), "cursor_style": ("bar", "block", "underline"), "density": ("comfortable", "compact")}
    ranges = {"font_size": (10, 22), "line_height": (1, 1.6), "terminal_padding": (8, 32), "left_width": (180, 320), "right_width": (260, 480)}
    for k, v in values.items():
        if k not in DEFAULT_PREFERENCES: raise ValueError("Unknown preference: " + k)
        if k in enums and v not in enums[k]: raise ValueError("Unsupported " + k)
        if k in ranges and (type(v) not in (int, float) or not ranges[k][0] <= v <= ranges[k][1]): raise ValueError("Out-of-range " + k)
        if k not in enums and k not in ranges and type(v) is not bool: raise ValueError(k + " must be boolean")
    return {**DEFAULT_PREFERENCES, **values}
MAX_TEXT = 2 * 1024 * 1024
POOL = concurrent.futures.ThreadPoolExecutor(max_workers=4)


def run(args, cwd=None, ok=(0,), timeout=30, env=None):
    p = subprocess.run([str(x) for x in args], cwd=cwd, capture_output=True,
                       timeout=timeout, env=env)
    if p.returncode not in ok:
        raise ValueError(p.stderr.decode(errors="replace").strip() or
                         p.stdout.decode(errors="replace").strip() or f"{args[0]} exited {p.returncode}")
    return p.stdout


def git(path, *args, **kwargs):
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0", LC_ALL="C")
    return run(["git", "--no-optional-locks", "--literal-pathspecs", "-C", path, *args], env=env, **kwargs)


def limited_diff(path, args):
    """Cap output in the producer so a generated diff cannot exhaust worker memory."""
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0", LC_ALL="C")
    with tempfile.TemporaryFile() as errors:
        p = subprocess.Popen(["git", "--no-optional-locks", "--literal-pathspecs", "-C", path, *args], stdout=subprocess.PIPE, stderr=errors, env=env)
        timer = threading.Timer(30, p.kill)
        timer.daemon = True
        timer.start()
        try:
            raw = p.stdout.read(MAX_TEXT + 1)
            truncated = len(raw) > MAX_TEXT
            if truncated: p.kill()
            p.wait()
            if p.returncode and not truncated:
                errors.seek(0)
                raise ValueError(errors.read(4096).decode(errors="replace").strip() or "Git diff timed out or failed")
            return raw[:MAX_TEXT], truncated
        finally:
            timer.cancel()
            p.stdout.close()
            if p.poll() is None: p.kill(); p.wait()


def text(b):
    return b.decode("utf-8", errors="replace").strip()


def atomic(path, value):
    path = Path(path)
    tmp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with tmp.open("w") as f:
            json.dump(value, f, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def ident(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}", value):
        raise ValueError("Use letters, numbers, dots, underscores, or hyphens (max 100 characters).")
    return value


def slug(value):
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")[:36] or "workspace"


def ref(value):
    if not value or value.startswith("-") or any(c in value for c in "\x00\n\r"):
        raise ValueError("Invalid Git reference")
    return value


def within(base, rel):
    base = Path(base).resolve()
    p = (base / rel).resolve()
    if not p.is_relative_to(base):
        raise ValueError("Path escapes the repository")
    return p


def parse_status(data):
    """Porcelain v2 -z. Rename records consume a separate original-path field."""
    result = {"branch": "", "head": "", "upstream": "", "ahead": 0, "behind": 0, "files": []}
    records = iter(data.split(b"\0"))
    for raw in records:
        if not raw:
            continue
        s = raw.decode("utf-8", errors="replace")
        if s.startswith("# "):
            key, _, value = s[2:].partition(" ")
            if key == "branch.head": result["branch"] = value
            if key == "branch.oid": result["head"] = value
            if key == "branch.upstream": result["upstream"] = value
            if key == "branch.ab":
                a, b = value.split()
                result["ahead"], result["behind"] = int(a[1:]), int(b[1:])
            continue
        if s.startswith("? "):
            result["files"].append({"path": s[2:], "index": "?", "worktree": "?", "untracked": True, "conflict": False})
        elif s[:2] in ("1 ", "2 ", "u "):
            kind = s[0]
            fields = s.split(" ", {"1": 8, "2": 9, "u": 10}[kind])
            xy = fields[1]
            item = {"path": fields[-1], "index": xy[0], "worktree": xy[1], "untracked": False, "conflict": kind == "u"}
            if kind == "2": item["original"] = next(records, b"").decode("utf-8", errors="replace")
            result["files"].append(item)
    return result


def session_name(terminal):
    return legacy_tmux_session(terminal) or "relay-" + ident(terminal)


def utf8_locale():
    return next((os.environ[k] for k in ("LC_ALL", "LC_CTYPE", "LANG") if "UTF-8" in os.environ.get(k, "").upper().replace("UTF8", "UTF-8")), "en_US.UTF-8")


def legacy_tmux_session(terminal):
    """Sessions created before dtach stay reachable until they end; Relay never creates tmux sessions."""
    terminal = ident(terminal)
    if not shutil.which("tmux"): return None
    for name in ("relay-" + terminal, "magi-" + terminal):
        if subprocess.run(["tmux", "has-session", "-t", "=" + name], capture_output=True).returncode == 0: return name
    return None


LOG_MAX, LOG_KEEP, REPLAY_BYTES = 4 << 20, 2 << 20, 512 << 10
# Queries a fresh xterm would answer into the live app's stdin when old output is replayed.
TERMINAL_QUERY = re.compile(rb"\x1b\[[>=?]?[\d;]*[cn]|\x1b\[\??[\d;]*\$p|\x1b\[>[\d;]*q|\x1b\[\?u|\x1b\[[\d;]*t"
                            rb"|\x1b\][\d;]*;\?(?:\x07|\x1b\\)|\x1bP[+$]q.*?\x1b\\", re.S)
SCREEN_TOKEN = re.compile(r"\x1b\[([?>=!]?)([\d;:]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_].*?(?:\x1b\\|\Z)"
                          r"|\x1b[()*+#%].|\x1b(.)|([\r\n\b\t])|([^\x1b\r\n\b\t]+)", re.S)


class DtachSession:
    """A dtach socket owning a Relay pty host, which logs output and records the shell pid."""
    def __init__(self, root, terminal):
        folder = Path(root) / "utils" / "term"
        self.base = folder / ident(terminal)
        self.sock, self.log, self.pids = (self.base.with_suffix(s) for s in (".sock", ".log", ".pid"))
        if len(str(self.sock)) > 100:
            # Unix socket paths are capped near 104 bytes; fall back to a private per-user directory.
            short = Path(tempfile.gettempdir()) / f"relay-{os.getuid()}"
            short.mkdir(mode=0o700, exist_ok=True)
            if short.stat().st_uid != os.getuid() or short.stat().st_mode & 0o077: raise ValueError("Unsafe terminal socket directory: " + str(short))
            self.sock = short / (hashlib.sha256(str(self.base).encode()).hexdigest()[:20] + ".sock")

    def live(self):
        import socket
        with socket.socket(socket.AF_UNIX) as s:
            try: s.connect(str(self.sock)); return True
            except FileNotFoundError: return False
            except ConnectionRefusedError:
                self.sock.unlink(missing_ok=True)
                return False

    def require_live(self):
        if not self.live(): raise ValueError("Terminal session is not live")

    def create(self, argv, cwd, env):
        if not shutil.which("dtach"): raise ValueError("dtach is required. Install it with brew install dtach (Mac), or apt install dtach on the VM.")
        self.log.parent.mkdir(parents=True, exist_ok=True)
        self.log.unlink(missing_ok=True)
        self.pids.unlink(missing_ok=True)
        host = [sys.executable, str(Path(__file__).resolve()), "--pty-host", str(self.log), str(self.pids), "--"]
        run(["dtach", "-n", self.sock, *host, *argv], cwd=cwd, env=env)

    def attach_command(self):
        return [sys.executable, str(Path(__file__).resolve()), "--attach", str(self.sock), str(self.log)]

    def pid(self):
        try: return int(self.pids.read_text().split()[1])
        except (OSError, IndexError, ValueError): return None

    def cwd(self):
        pid = self.pid()
        if not pid: raise ValueError("Terminal directory is unavailable")
        if Path("/proc", str(pid)).exists(): return os.readlink(f"/proc/{pid}/cwd")
        out = text(run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"], ok=(0, 1)))
        cwd = next((line[1:] for line in out.splitlines() if line.startswith("n")), "")
        if not cwd: raise ValueError("Terminal directory is unavailable")
        return cwd

    def read(self, lines):
        size = self.columns_rows()
        data = tail_bytes(self.log, LOG_KEEP)
        return "\n".join(render_screen(data, *size)[-lines:])

    def columns_rows(self):
        try:
            cols, rows = map(int, self.pids.read_text().split()[2:4])
            return max(cols, 2), max(rows, 2)
        except (OSError, ValueError): return 80, 24

    def send(self, data):
        if not shutil.which("dtach"): raise ValueError("dtach is required")
        p = subprocess.run(["dtach", "-p", str(self.sock)], input=data, capture_output=True, timeout=10)
        if p.returncode: raise ValueError(text(p.stderr) or "Could not send input to the terminal")

    def kill(self):
        import signal
        try: host, shell = map(int, self.pids.read_text().split()[:2])
        except (OSError, ValueError): host = shell = None
        # Closing the pty master hangs up the whole session, like closing a terminal window.
        for pid, sig in ((host, signal.SIGTERM), (shell, signal.SIGHUP)):
            if pid:
                with contextlib.suppress(OSError): os.kill(pid, sig)
        for _ in range(50):
            if not self.live(): break
            time.sleep(.02)
        for path in (self.sock, self.log, self.pids): path.unlink(missing_ok=True)


def tail_bytes(path, limit):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - limit))
            data = f.read()
    except OSError: return b""
    # Start on a line boundary so replay never begins inside an escape sequence.
    return data[data.find(b"\n") + 1:] if size > limit and b"\n" in data else data


def render_screen(data, cols, rows):
    """Small VT model for `terminal read`: enough cursor and erase handling to collapse TUI redraws."""
    lines, main, row, col, saved = [[]], None, 0, 0, (0, 0)
    top = lambda: max(0, len(lines) - rows)
    def goto(r, c):
        nonlocal row, col
        row, col = max(0, r), max(0, min(c, cols - 1))
        while len(lines) <= row: lines.append([])
    for m in SCREEN_TOKEN.finditer(data.decode("utf-8", "replace")):
        prefix, params, final, esc, control, chunk = m.groups()
        if chunk:
            for ch in chunk:
                if ch < " " or ch == "\x7f": continue
                if col >= cols: goto(row + 1, 0)
                line = lines[row]
                line.extend(" " * (col - len(line)))
                if col < len(line): line[col] = ch
                else: line.append(ch)
                col += 1
        elif control == "\r": col = 0
        elif control == "\n": goto(row + 1, col)
        elif control == "\b": col = max(0, col - 1)
        elif control == "\t": col = min(cols - 1, (col // 8 + 1) * 8)
        elif esc == "7": saved = (row - top(), col)
        elif esc == "8": goto(top() + saved[0], saved[1])
        elif esc in ("D", "E"): goto(row + 1, 0 if esc == "E" else col)
        elif esc == "M":
            if row > top(): row -= 1
            else: lines.insert(row, [])
        elif final:
            nums = [int(n) if n.isdigit() else 0 for n in params.replace(":", ";").split(";")] if params else []
            n = max(1, nums[0]) if nums else 1
            line = lines[row]
            if prefix == "?" and final in "hl" and {47, 1047, 1049} & set(nums):
                if final == "h" and main is None: main, lines, row, col = (lines, row, col), [[] for _ in range(rows)], 0, 0
                elif final == "l" and main is not None: (lines, row, col), main = main, None
            elif prefix: continue
            elif final == "A": goto(max(top(), row - n), col)
            elif final in "Be": goto(row + n, col)
            elif final in "Ca": goto(row, col + n)
            elif final == "D": goto(row, col - n)
            elif final in "EF": goto(row + n if final == "E" else max(top(), row - n), 0)
            elif final in "G`": goto(row, n - 1)
            elif final in "Hf": goto(top() + (max(1, nums[0]) if nums else 1) - 1, (max(1, nums[1]) if len(nums) > 1 else 1) - 1)
            elif final == "d": goto(top() + n - 1, col)
            elif final == "K":
                mode = nums[0] if nums else 0
                if mode == 0: del line[col:]
                elif mode == 1: line[:col + 1] = [" "] * min(len(line), col + 1)
                else: line.clear()
            elif final == "J":
                mode = nums[0] if nums else 0
                if mode == 0: del line[col:]; del lines[row + 1:]
                elif mode == 1: lines[top():row] = [[] for _ in range(row - top())]
                elif mode == 2: lines[top():] = [[] for _ in lines[top():]]
                elif mode == 3:
                    drop = top()
                    del lines[:drop]
                    row -= drop
            elif final == "L": lines[row:row] = [[] for _ in range(n)]
            elif final == "M": del lines[row:row + n]; goto(row, col)
            elif final == "P": del line[col:col + n]
            elif final == "@": line[col:col] = [" "] * n
            elif final == "X": line[col:col + n] = [" "] * min(n, max(0, len(line) - col))
            elif final == "S": lines.extend([] for _ in range(n))
            elif final == "s": saved = (row - top(), col)
            elif final == "u": goto(top() + saved[0], saved[1])
    return ["".join(l).rstrip() for l in lines]


def migrate_root(root):
    requested = Path(root).expanduser().absolute()
    target = requested.parent.resolve() / requested.name
    old_name = {"Relay": "Magi", "relay": "magi"}.get(target.name)
    if not old_name: return target
    legacy = target.with_name(old_name)
    if not target.exists() and legacy.exists() and not legacy.is_symlink():
        legacy.rename(target)
        legacy.symlink_to(target, target_is_directory=True)
    if not legacy.is_symlink() or legacy.resolve() != target.resolve(): return target
    def rewrite(value):
        if isinstance(value, str):
            if value == str(legacy) or value.startswith(str(legacy) + "/"):
                return str(target) + value[len(str(legacy)):]
            return "~/relay" if value == "~/magi" else value
        if isinstance(value, list): return [rewrite(v) for v in value]
        if isinstance(value, dict): return {k: rewrite(v) for k, v in value.items()}
        return value
    manifests = [target / "utils" / "registry.json", *target.glob("workspaces/*/workspace.json")]
    for path in manifests:
        if path.exists():
            before = json.loads(path.read_text()); after = rewrite(before)
            if before != after: atomic(path, after)
            guide = path.parent / "AGENTS.md"
            if path.name == "workspace.json" and guide.exists():
                content = guide.read_text()
                if content.startswith(("# Magi workspace:", "# Relay workspace:")):
                    updated = content.replace("# Magi workspace:", "# Relay workspace:").replace(str(legacy) + "/", str(target) + "/").replace("`magi ", "`relay ")
                    if updated != content: guide.write_text(updated)
    runtime = target / "utils" / "relay"
    old_runtime = target / "utils" / "magi"
    if old_runtime.exists() and not old_runtime.is_symlink() and not runtime.exists():
        old_runtime.rename(runtime); old_runtime.symlink_to(runtime, target_is_directory=True)
    return target


class Backend:
    def __init__(self, root=None):
        self.root = migrate_root(root or os.environ.get("RELAY_ROOT") or os.environ.get("MAGI_ROOT") or str(Path.home() / "Documents" / "Relay" if sys.platform == "darwin" else Path.home() / "relay")).resolve()
        for folder in ("workspaces", "repos", "util_repos", "utils"):
            (self.root / folder).mkdir(parents=True, exist_ok=True)
        self.config_path = self.root / "utils" / "registry.json"
        self.cache = {}
        self.cache_lock = threading.Lock()
        self.thread_lock = threading.RLock()
        with self.lock():
            if not self.config_path.exists(): atomic(self.config_path, {"repos": [], "hosts": []})
            self.ensure_general()

    def ensure_general(self):
        # Called under the host mutation lock, including on existing installations.
        path = self.ws_path("genral")
        manifest = path / "workspace.json"
        if manifest.exists():
            ws = self.ws("genral")
            if ws.get("permanent") and not ws.get("archived") and ws.get("name") == "Genral": return
            ws.update(name="Genral", permanent=True, archived=False)
        else:
            (path / "repos").mkdir(parents=True, exist_ok=True)
            ws = {"id": "genral", "name": "Genral", "path": str(path), "created": time.time(),
                  "repos": [], "terminals": [{"id": uuid.uuid4().hex[:12], "name": "Terminal 1", "cwd": str(path)}],
                  "ticket": None, "archived": False, "permanent": True}
        self.save_ws(ws)
        self.context(ws)

    @contextlib.contextmanager
    def lock(self):
        with self.thread_lock:
            with (self.root / "utils" / "mutation.lock").open("a+") as f:
                fcntl.flock(f, fcntl.LOCK_EX)
                try: yield
                finally: fcntl.flock(f, fcntl.LOCK_UN)

    def config(self):
        return json.loads(self.config_path.read_text())

    def preferences_get(self):
        p = self.root / "utils" / "preferences.json"
        try: return validate_preferences(json.loads(p.read_text())) if p.exists() else dict(DEFAULT_PREFERENCES)
        except (ValueError, OSError): return dict(DEFAULT_PREFERENCES)

    def preferences_set(self, values, **_):
        with self.lock():
            result = validate_preferences({**self.preferences_get(), **values})
            atomic(self.root / "utils" / "preferences.json", result)
        return result

    def ws_path(self, wid):
        return self.root / "workspaces" / ident(wid)

    def ws(self, wid):
        p = self.ws_path(wid) / "workspace.json"
        if not p.exists(): raise ValueError("Workspace not found: " + wid)
        return json.loads(p.read_text())

    def save_ws(self, ws):
        ws["updated"] = time.time()
        atomic(self.ws_path(ws["id"]) / "workspace.json", ws)

    def attachment(self, wid, rid):
        ws = self.ws(wid)
        for r in ws["repos"] + [r for r in self.config()["repos"] if r.get("utility")]:
            if r["id"] == rid: return r
        raise ValueError("Repository is not attached to this workspace")

    def changes(self, **_):
        # Cheap stat fingerprint of everything snapshot reads, so clients notice CLI/agent edits.
        sess = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "sess" / "config.json"
        files = [self.config_path, self.root / "utils" / "preferences.json", self.root / "workspaces",
                 Path(os.environ.get("SESS_CONFIG", str(sess))), Path(os.environ.get("SESS_DIR", str(Path.home() / ".sess"))) / "remote",
                 *sorted((self.root / "workspaces").glob("*/workspace.json"))]
        parts = []
        for f in files:
            try: st = f.stat(); parts.append(f"{f}:{st.st_ino}:{st.st_mtime_ns}:{st.st_size}")
            except OSError: parts.append(f"{f}:-")
        return {"fingerprint": hashlib.sha256("\n".join(parts).encode()).hexdigest()[:24]}

    def snapshot(self, **_):
        fingerprint = self.changes()["fingerprint"]
        config = self.config()
        workspaces, errors = [], []
        for f in (self.root / "workspaces").glob("*/workspace.json"):
            try:
                ws = json.loads(f.read_text())
                if not ws.get("archived"): workspaces.append(ws)
            except (OSError, ValueError) as e: errors.append(str(e))
        order = config.get("workspace_order", [])
        workspaces.sort(key=lambda w: (order.index(w["id"]) if w["id"] in order else len(order), w["id"] != "genral", w["created"]))
        remotes = []
        known = {h["ssh"] for h in config["hosts"]}
        modern = Path(os.environ.get("SESS_CONFIG", str(Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "sess" / "config.json")))
        if modern.exists():
            try:
                settings = json.loads(modern.read_text())
                presets = settings.get("hosts", []) + [settings.get("host", "")]
                for host in presets:
                    if isinstance(host, str) and re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.@:-]*", host) and host not in known:
                        remotes.append({"name": host, "ssh": host, "root": "~/relay"})
                        known.add(host)
            except (OSError, ValueError, TypeError) as error: errors.append("Could not read sess presets: " + str(error))
        sess_config = Path(os.environ.get("SESS_DIR", str(Path.home() / ".sess"))) / "remote"
        if sess_config.exists():
            for line in sess_config.read_text().splitlines():
                key, sep, host = line.partition("=")
                # Presets win: a legacy alias (sess's "default" slot) for a covered host is noise.
                if sep and key.endswith(".host") and host and host not in known:
                    remotes.append({"name": key[:-5], "ssh": host, "root": "~/relay"})
                    known.add(host)
        return {"version": VERSION, "fingerprint": fingerprint, "root": str(self.root), **config, "preferences": self.preferences_get(), "workspaces": workspaces,
                "sessRemotes": remotes, "errors": errors,
                "tools": {t: shutil.which(t) is not None for t in ("git", "dtach", "ssh", "gh", "linear", "python3")}}

    @staticmethod
    def validate_host(name, ssh, root):
        ident(name)
        if name == "local": raise ValueError("local is reserved")
        if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.@:-]*", ssh): raise ValueError("Enter an SSH config alias or user@host")
        if not (root.startswith("/") or root.startswith("~/")): raise ValueError("VM root must be absolute or begin with ~/")
        if any(c in root for c in "\x00\n\r"): raise ValueError("Invalid root path")

    def host_add(self, name, ssh, root="~/relay", **_):
        self.validate_host(name, ssh, root)
        with self.lock():
            c = self.config()
            if any(h["name"] == name for h in c["hosts"]): raise ValueError("A host with that name already exists")
            c["hosts"].append({"name": name, "ssh": ssh, "root": root})
            atomic(self.config_path, c)
        return c

    def host_update(self, name, ssh=None, root=None, new_name=None, **_):
        with self.lock():
            c = self.config()
            current = next((h for h in c["hosts"] if h["name"] == name), None)
            if not current: raise ValueError("Unknown host: " + name)
            new_name, ssh, root = new_name or name, ssh or current["ssh"], root or current["root"]
            self.validate_host(new_name, ssh, root)
            if new_name != name and any(h["name"] == new_name for h in c["hosts"]): raise ValueError("A host with that name already exists")
            c["hosts"] = [{"name": new_name, "ssh": ssh, "root": root} if h["name"] == name else h for h in c["hosts"]]
            atomic(self.config_path, c)
        return c

    def host_remove(self, name, **_):
        ident(name)
        with self.lock():
            c = self.config()
            if not any(h["name"] == name for h in c["hosts"]): raise ValueError("Unknown host: " + name)
            c["hosts"] = [h for h in c["hosts"] if h["name"] != name]
            atomic(self.config_path, c)
        return c

    def repo_register(self, path="", name="", url="", utility=False, **_):
        name = ident(name or Path((path or url).rstrip("/")).name.removesuffix(".git"))
        with self.lock():
            c = self.config()
            if any(r["id"] == name for r in c["repos"]): raise ValueError("Repository name already registered")
            if url:
                if url.startswith("-"): raise ValueError("Invalid clone URL")
                if not shutil.which("gh"): raise ValueError("GitHub CLI is missing on this host. Install gh, then run gh auth login.")
                if not (re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", url) or url.startswith("https://") or url.startswith("git@")):
                    raise ValueError("Enter owner/repo or a GitHub repository URL")
                p = self.root / ("util_repos" if utility else "repos") / name
                if p.exists(): raise ValueError("Clone destination already exists")
                run(["gh", "repo", "clone", url, str(p)], timeout=180, env=dict(os.environ, GIT_TERMINAL_PROMPT="0", GH_PROMPT_DISABLED="1"))
            else:
                p = Path(path).expanduser().resolve()
            canonical = Path(text(git(p, "rev-parse", "--show-toplevel"))).resolve()
            if any(Path(r["path"]).resolve() == canonical for r in c["repos"]): raise ValueError("This repository is already registered")
            row = {"id": name, "name": name, "path": str(canonical), "utility": bool(utility)}
            c["repos"].append(row)
            atomic(self.config_path, c)
            return row

    def repo_inventory(self, **_):
        snapshot = self.snapshot()
        def detail(row):
            result = self.status_one(row, compare=False)
            try:
                remote = text(git(row["path"], "remote", "get-url", "origin", ok=(0, 2, 128)))
                if remote.startswith(("http://", "https://")):
                    parsed = urlsplit(remote)
                    remote = parsed.scheme + "://" + (parsed.hostname or "") + ((":" + str(parsed.port)) if parsed.port else "") + parsed.path
                result["remote"] = remote
            except Exception: result["remote"] = ""
            result["workspaces"] = [{"id": w["id"], "name": w["name"], "path": r["path"], "branch": r.get("branch", "")} for w in snapshot["workspaces"] for r in w["repos"] if r["id"] == row["id"]]
            return result
        return {"repos": list(POOL.map(detail, snapshot["repos"]))}

    def branches(self, repo, **_):
        r = next((r for r in self.config()["repos"] if r["id"] == repo), None)
        if not r: raise ValueError("Unknown repository")
        return text(git(r["path"], "for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes")).splitlines()

    def workspace_create(self, name, repos=None, ticket="", **_):
        name = name.strip()
        if not name or len(name) > 120: raise ValueError("Workspace name must be 1–120 characters")
        issue = self.linear_issue(ticket) if ticket and ticket.strip() else None
        wid = slug(name) + "-" + uuid.uuid4().hex[:8]
        with self.lock():
            path = self.ws_path(wid)
            (path / "repos").mkdir(parents=True)
            ws = {"id": wid, "name": name, "path": str(path), "created": time.time(), "repos": [], "terminals": [], "ticket": issue["identifier"] if issue else None, "archived": False}
            self.save_ws(ws)
            self.context(ws)
        errors = []
        for r in repos or []:
            try: self.repo_attach(wid, **r)
            except Exception as e: errors.append({"repo": r.get("repo"), "error": str(e)})
        if not errors: self.terminal_new(wid)
        return {"workspace": self.ws(wid), "errors": errors}

    def context(self, ws):
        lines = ["# Relay workspace: " + ws["name"], "", "This is a Relay workspace. Use the `relay` CLI, not `orca`, `orca-ide`, or Orca orchestration skills.",
                 "Relay CLI documentation: [commands and agent usage](https://github.com/DeepakSilaych/relay/blob/main/resources/relay/backend/RELAY-CLI.md).",
                 "Read the CLI guide at " + str(self.root / "utils" / "relay" / "RELAY-CLI.md") + ".",
                 "Relay is a separate application; Orca ancestry does not imply its orchestration runtime is installed.",
                 "Run agents from this workspace. Each task repository must be attached before editing.",
                 "Start a persistent agent: `relay --workspace " + ws["id"] + " terminal run --name Review --command 'codex' --json`.",
                 "Inspect output with `relay --workspace " + ws["id"] + " terminal read --terminal ID --json`; send input with `terminal send --terminal ID --input-text TEXT --enter`.",
                 "Use `relay repo attach NAME --new-branch task/NAME --base HEAD --json` to create a worktree.",
                 "Edit only the returned worktree path. Do not edit canonical clones for task work.",
                 "A Git worktree is isolation by convention, not a security sandbox.", "", "## Attached repositories"]
        lines.extend("- " + r["id"] + ": " + r["path"] + " (" + r["branch"] + ")" for r in ws["repos"])
        lines.extend(["", "## Shared utility repositories (changes are shared)"])
        lines.extend("- " + r["id"] + ": " + r["path"] for r in self.config()["repos"] if r.get("utility"))
        (self.ws_path(ws["id"]) / "AGENTS.md").write_text("\n".join(lines) + "\n")

    def repo_attach(self, workspace, repo, branch="", new_branch="", base="HEAD", **_):
        with self.lock():
            ws = self.ws(workspace)
            previous = next((r for r in ws["repos"] if r["id"] == repo), None)
            if previous:
                if (branch or new_branch) and previous["branch"] != (branch or new_branch): raise ValueError("Repo already attached on another branch")
                return previous
            r = next((r for r in self.config()["repos"] if r["id"] == repo), None)
            if not r: raise ValueError("Register the repository first")
            if r.get("utility"): raise ValueError("Utility repos are shared directly and do not use worktrees")
            if branch and new_branch: raise ValueError("Choose an existing branch OR a new branch")
            branch_name = ref(branch or new_branch or ("relay/" + workspace))
            git(r["path"], "check-ref-format", "--branch", branch_name)
            base_ref = ref(branch if branch else base)
            base_commit = text(git(r["path"], "rev-parse", "--verify", base_ref + "^{commit}"))
            path = self.ws_path(workspace) / "repos" / ident(repo)
            if path.exists(): raise ValueError("Worktree directory already exists; inspect it before retrying")
            if branch:
                git(r["path"], "show-ref", "--verify", "refs/heads/" + branch)
                git(r["path"], "worktree", "add", str(path), branch, timeout=120)
            else:
                git(r["path"], "worktree", "add", "-b", branch_name, str(path), base_commit, timeout=120)
            row = {"id": repo, "name": r["name"], "path": str(path), "canonical": r["path"], "branch": branch_name, "base": base_commit, "utility": False}
            ws["repos"].append(row)
            self.save_ws(ws)
            self.context(ws)
            return row

    def workspace_rename(self, workspace, name, **_):
        name = name.strip()
        if not name or len(name) > 120 or any(ord(c) < 32 for c in name):
            raise ValueError("Workspace name must be 1–120 characters without control characters")
        with self.lock():
            ws = self.ws(workspace)
            if workspace == "genral" or ws.get("permanent"):
                raise ValueError("Genral's name is permanent")
            ws["name"] = name
            self.save_ws(ws)
            self.context(ws)
        return ws

    def terminal_rename(self, workspace, terminal, name, **_):
        name = name.strip()
        if not name or len(name) > 120 or any(ord(c) < 32 for c in name):
            raise ValueError("Terminal name must be 1–120 characters without control characters")
        with self.lock():
            ws = self.ws(workspace)
            t = next((t for t in ws["terminals"] if t["id"] == terminal), None)
            if not t: raise ValueError("Unknown terminal")
            t["name"] = name
            self.save_ws(ws)
        return t

    def workspace_archive(self, workspace, **_):
        with self.lock():
            ws = self.ws(workspace)
            if workspace == "genral" or ws.get("permanent"):
                raise ValueError("Genral is permanent and cannot be archived or deleted")
            ws["archived"] = True
            self.save_ws(ws)
        return {"archived": True, "retained": "All worktrees and terminal processes are retained"}

    def terminal_new(self, workspace, name="", cwd="", command="", **_):
        with self.lock():
            ws = self.ws(workspace)
            path = within(ws["path"], cwd) if cwd else Path(ws["path"])
            if not path.is_dir(): raise ValueError("Terminal directory does not exist")
            t = {"id": uuid.uuid4().hex[:12], "name": name or ("Terminal " + str(len(ws["terminals"]) + 1)), "cwd": str(path)}
            if command: t["launch_command"] = command
            ws["terminals"].append(t)
            self.save_ws(ws)
            return t

    def terminal_run(self, workspace, command, name="", cwd="", **_):
        if not isinstance(command, str) or not command.strip() or len(command) > 65536 or "\x00" in command:
            raise ValueError("Provide a nonempty shell command, at most 64 KiB")
        terminal = self.terminal_new(workspace, name, cwd, command)
        self.terminal_prepare(workspace, terminal["id"])
        return {"terminal": terminal, "session": session_name(terminal["id"]), "state": "live"}

    def terminal_target(self, workspace, terminal):
        """A live session: a legacy tmux target string, or a DtachSession."""
        if not any(t["id"] == terminal for t in self.ws(workspace)["terminals"]):
            raise ValueError("Terminal does not belong to this workspace")
        legacy = legacy_tmux_session(terminal)
        if legacy: return "=" + legacy + ":"
        session = DtachSession(self.root, terminal)
        session.require_live()
        return session

    def terminal_read(self, workspace, terminal, lines=200, **_):
        lines = int(lines)
        if not 1 <= lines <= 10000: raise ValueError("lines must be between 1 and 10000")
        target = self.terminal_target(workspace, terminal)
        if isinstance(target, DtachSession): output = target.read(lines)
        else: output = text(run(["tmux", "capture-pane", "-p", "-J", "-t", target, "-S", str(-lines)]))
        return {"terminal": terminal, "state": "live", "output": output}

    def terminal_send(self, workspace, terminal, input_text="", enter=False, **_):
        if not isinstance(input_text, str) or len(input_text) > 65536 or "\x00" in input_text:
            raise ValueError("Terminal input must be text, at most 64 KiB")
        target = self.terminal_target(workspace, terminal)
        if isinstance(target, DtachSession):
            # Separate writes, like tmux send-keys, so TUIs don't treat text+Enter as one paste.
            if input_text: target.send(input_text.encode())
            if enter: target.send(b"\r")
        else:
            if input_text: run(["tmux", "send-keys", "-t", target, "-l", "--", input_text])
            if enter: run(["tmux", "send-keys", "-t", target, "Enter"])
        return {"sent": len(input_text), "enter": bool(enter)}

    def live_cwd(self, terminal):
        legacy = legacy_tmux_session(terminal)
        if legacy: return text(run(["tmux", "display-message", "-p", "-t", "=" + legacy + ":", "#{pane_current_path}"]))
        return DtachSession(self.root, terminal).cwd()

    def workspace_reorder(self, ids, **_):
        with self.lock():
            current = [w["id"] for w in self.snapshot()["workspaces"]]
            if len(ids) != len(set(ids)) or set(ids) != set(current):
                raise ValueError("Workspace list changed. Refresh and reorder again.")
            config = self.config()
            config["workspace_order"] = ids
            atomic(self.config_path, config)
        return {"ids": ids}

    def terminal_reorder(self, workspace, ids, **_):
        with self.lock():
            ws = self.ws(workspace)
            groups = list(dict.fromkeys(t.get("tab_id", t["id"]) for t in ws["terminals"]))
            if len(ids) != len(set(ids)) or set(ids) != set(groups):
                raise ValueError("Terminal list changed. Refresh and reorder again.")
            ws["terminals"].sort(key=lambda t: ids.index(t.get("tab_id", t["id"])))
            self.save_ws(ws)
        return {"ids": ids}

    def terminal_split(self, workspace, terminal, axis="columns", **_):
        if axis not in ("columns", "rows"): raise ValueError("Invalid split direction")
        with self.lock():
            ws = self.ws(workspace)
            source = next((t for t in ws["terminals"] if t["id"] == terminal), None)
            if not source: raise ValueError("Unknown terminal")
            cwd = source["cwd"]
            if source.get("started"):
                cwd = self.live_cwd(terminal)
                if not Path(cwd).is_dir(): raise ValueError("Terminal directory is unavailable")
            tab = source.get("tab_id", source["id"])
            layouts = ws.setdefault("layouts", {})
            tree = layouts.get(tab, {"terminal": source["id"]})
            t = {"id": uuid.uuid4().hex[:12], "name": "Terminal " + str(len(ws["terminals"]) + 1), "cwd": cwd, "tab_id": tab}
            found = False
            def split(node):
                nonlocal found
                if node.get("terminal") == terminal:
                    found = True
                    return {"id": uuid.uuid4().hex[:12], "axis": axis, "ratio": 0.5, "first": node, "second": {"terminal": t["id"]}}
                if "terminal" in node: return node
                return {**node, "first": split(node["first"]), "second": split(node["second"])}
            layouts[tab] = split(tree)
            if not found: raise ValueError("Pane layout changed. Refresh and retry.")
            source["tab_id"] = tab
            ws["terminals"].insert(ws["terminals"].index(source) + 1, t)
            self.save_ws(ws)
        return t

    def terminal_resize(self, workspace, node, ratio, **_):
        ratio = float(ratio)
        if not 0.1 <= ratio <= 0.9: raise ValueError("Split ratio must be between 0.1 and 0.9")
        with self.lock():
            ws = self.ws(workspace)
            def resize(tree):
                if "terminal" in tree: return False
                if tree["id"] == node:
                    tree["ratio"] = ratio
                    return True
                return resize(tree["first"]) or resize(tree["second"])
            if not any(resize(tree) for tree in ws.get("layouts", {}).values()): raise ValueError("Split no longer exists")
            self.save_ws(ws)
        return {"ratio": ratio}

    def terminal_prepare(self, workspace, terminal, **_):
        with self.lock():
            ws = self.ws(workspace)
            t = next((t for t in ws["terminals"] if t["id"] == terminal), None)
            if not t: raise ValueError("Unknown terminal")
            self.install_cli()
            capabilities = {"TERM": "xterm-256color", "COLORTERM": "truecolor", "TERM_PROGRAM": "Relay", "TERM_PROGRAM_VERSION": VERSION, "FORCE_HYPERLINK": "1"}
            path = str(self.root / "utils" / "bin") + os.pathsep + os.environ.get("PATH", "")
            attach_env = {"RELAY_ROOT": str(self.root), "RELAY_WORKSPACE": workspace, "PATH": path, "LANG": utf8_locale(), **capabilities}
            legacy = legacy_tmux_session(terminal)
            if legacy:
                # xterm owns drag selection; tmux owns wheel scrolling through its history.
                run(["tmux", "set-option", "-t", legacy, "mouse", "on"])
                return {"program": "tmux", "args": ["-u", "-T", "RGB,hyperlinks", "attach-session", "-t", "=" + legacy], "env": attach_env, "cwd": t["cwd"]}
            session = DtachSession(self.root, terminal)
            if not session.live():
                if t.get("started"):
                    raise ValueError("This session has exited. Create a new terminal to start another shell.")
                shell = os.environ.get("SHELL", "/bin/bash")
                resume = t.get("agent_resume")
                if t.get("launch_command"):
                    argv = [shell, "-lic", t["launch_command"] + "; exec " + shlex.quote(shell) + " -l"]
                elif resume:
                    agent = resume.get("agent")
                    if agent not in ("codex", "claude"): raise ValueError("Unsupported imported agent")
                    session_id = resume.get("session_id")
                    if session_id:
                        if not re.fullmatch(r"[a-fA-F0-9-]{36}", session_id): raise ValueError("Invalid imported session ID")
                        command = [agent, "resume" if agent == "codex" else "--resume", session_id]
                    else: command = [agent]
                    command_text = " ".join(shlex.quote(arg) for arg in command)
                    argv = [shell, "-lic", command_text + "; exec " + shlex.quote(shell) + " -l"]
                else: argv = [shell, "-l"]
                env = {k: v for k, v in os.environ.items() if k not in ("NO_COLOR", "CI", "FORCE_COLOR", "CLICOLOR", "TMUX", "TMUX_PANE")}
                session.create(argv, t["cwd"], {**env, **attach_env})
                t["started"] = True
                self.save_ws(ws)
            command = session.attach_command()
            return {"program": command[0], "args": command[1:], "env": attach_env, "cwd": t["cwd"]}

    def terminal_state(self, workspace, terminal, **_):
        t = next((t for t in self.ws(workspace)["terminals"] if t["id"] == terminal), None)
        if not t: return {"state": "exited"}
        live = legacy_tmux_session(terminal) or DtachSession(self.root, terminal).live()
        return {"state": "live" if live or not t.get("started") else "exited"}

    def terminal_remove(self, workspace, terminal, **_):
        with self.lock():
            ws = self.ws(workspace)
            if not any(t["id"] == terminal for t in ws["terminals"]): raise ValueError("Unknown terminal")
            legacy = legacy_tmux_session(terminal)
            if legacy: run(["tmux", "kill-session", "-t", "=" + legacy], ok=(0, 1))
            DtachSession(self.root, terminal).kill()
            ws["terminals"] = [t for t in ws["terminals"] if t["id"] != terminal]
            def prune(tree):
                if "terminal" in tree: return None if tree["terminal"] == terminal else tree
                first, second = prune(tree["first"]), prune(tree["second"])
                return {**tree, "first": first, "second": second} if first and second else first or second
            ws["layouts"] = {key: tree for key, value in ws.get("layouts", {}).items() if (tree := prune(value))}
            self.save_ws(ws)
        return {"closed": True}

    def install_cli(self):
        folder = self.root / "utils" / "relay"
        folder.mkdir(parents=True, exist_ok=True)
        for filename in ("relay.py", "RELAY-CLI.md"):
            src = Path(__file__).resolve().parent / filename
            dest = folder / filename
            if src != dest and (not dest.exists() or src.read_bytes() != dest.read_bytes()): shutil.copy2(src, dest)
        binary = self.root / "utils" / "bin"
        binary.mkdir(exist_ok=True)
        launcher = binary / "relay"
        launcher.write_text("#!/bin/sh\nexec python3 " + shlex.quote(str(folder / "relay.py")) + " \"$@\"\n")
        launcher.chmod(0o755)
        legacy = binary / "magi"
        legacy.write_text(launcher.read_text())
        legacy.chmod(0o755)
        (folder / "magi.py").write_text("#!/usr/bin/env python3\nimport runpy\nrunpy.run_path(" + repr(str(folder / "relay.py")) + ", run_name=\"__main__\")\n")
        documentation = "Relay CLI documentation: [commands and agent usage](https://github.com/DeepakSilaych/relay/blob/main/resources/relay/backend/RELAY-CLI.md)."
        for manifest in (self.root / "workspaces").glob("*/workspace.json"):
            guide = manifest.parent / "AGENTS.md"
            content = guide.read_text() if guide.exists() else ""
            if "https://github.com/DeepakSilaych/relay/blob/main/resources/relay/backend/RELAY-CLI.md" not in content:
                guide.write_text(content.rstrip() + "\n\n" + documentation + "\n")
        return {"path": str(launcher)}

    def comparison_target(self, row, selected="auto"):
        candidates = [selected] if selected != "auto" else ["dev", "origin/dev", "main", "origin/main", "master", "origin/master", "HEAD"]
        for candidate in candidates:
            commit = text(git(row["path"], "rev-parse", "--verify", ref(candidate) + "^{commit}", ok=(0, 128)))
            if commit: return candidate, commit
        raise ValueError("Comparison ref does not resolve to a commit: " + selected)

    def repo_compare(self, workspace, repo, comparison_ref="auto", **_):
        with self.lock():
            row = self.attachment(workspace, repo)
            selected, commit = self.comparison_target(row, comparison_ref)
            ws = self.ws(workspace)
            ws.setdefault("comparisonRefs", {})[repo] = comparison_ref
            self.save_ws(ws)
            return {"ref": selected, "commit": commit}

    def comparison(self, row):
        selected = row.get("comparison_ref", "auto")
        try:
            selected, commit = self.comparison_target(row, selected)
            parts = git(row["path"], "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-status", "-z", commit, "--").decode(errors="replace").split("\0")
            files = [{"path": parts[i + 1], "index": ".", "worktree": parts[i], "untracked": False, "conflict": False} for i in range(0, len(parts) - 1, 2)]
            known = {f["path"] for f in files}
            for path in git(row["path"], "ls-files", "--others", "--exclude-standard", "-z").decode(errors="replace").split("\0"):
                if path and path not in known:
                    files.append({"path": path, "index": ".", "worktree": "A", "untracked": True, "conflict": False})
            return {"ref": selected, "commit": commit, "files": files, "error": None}
        except Exception as e:
            return {"ref": selected, "files": [], "error": str(e)}

    def status_one(self, row, compare=True):
        try:
            data = git(row["path"], "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all")
            return {**row, **parse_status(data), "comparison": self.comparison(row) if compare else None, "error": None}
        except Exception as e:
            return {**row, "files": [], "error": str(e)}

    def terminal_agents(self, terminals):
        if not any(t.get("started") for t in terminals): return {t["id"]: None for t in terminals}
        try:
            panes = "".join(f"relay-{t['id']}\t{pid}\n" for t in terminals if t.get("started") and (pid := DtachSession(self.root, t["id"]).pid()))
            if shutil.which("tmux"):
                panes += text(run(["tmux", "list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"], ok=(0, 1), timeout=3))
            processes = text(run(["ps", "-axo", "pid=,ppid=,pgid=,tpgid=,args="], timeout=3))
            return foreground_agents(panes, processes, terminals)
        except (OSError, ValueError, subprocess.TimeoutExpired): return None

    def status(self, workspace, **_):
        ws = self.ws(workspace)
        rows = ws["repos"] + [r for r in self.config()["repos"] if r.get("utility")]
        start = time.monotonic()
        results = list(POOL.map(self.status_one, [{**r, "comparison_ref": ws.get("comparisonRefs", {}).get(r["id"], "auto")} for r in rows]))
        return {"repos": results, "agents": self.terminal_agents(ws["terminals"]), "elapsedMs": round((time.monotonic() - start) * 1000, 1), "at": time.time()}

    def terminal_cwd(self, workspace, terminal, **_):
        ws = self.ws(workspace)
        session = next((t for t in ws["terminals"] if t["id"] == terminal), None)
        if not session: raise ValueError("Unknown terminal")
        cwd = session["cwd"]
        if session.get("started"):
            cwd = self.live_cwd(terminal)
        return {"path": cwd}

    def file_info(self, workspace, repo, path, **_):
        ws = self.ws(workspace)
        if repo == "@files":
            p = Path(path).expanduser()
            if not p.is_absolute(): raise ValueError("File link must be absolute")
        else:
            root = ws["path"] if repo == "@workspace" else self.attachment(workspace, repo)["path"]
            p = within(root, path)
        return {"absolutePath": str(p.resolve())}

    def resolve_links(self, workspace, terminal, paths, **_):
        if not isinstance(paths, list) or len(paths) > 64: raise ValueError("Too many link candidates")
        ws = self.ws(workspace)
        session = next((t for t in ws["terminals"] if t["id"] == terminal), None)
        if not session: raise ValueError("Unknown terminal")
        cwd = session["cwd"]
        if session.get("started"):
            cwd = self.live_cwd(terminal)
        result = []
        for value in paths:
            if not isinstance(value, str) or len(value) > 4096: raise ValueError("Invalid file path")
            path = Path(value).expanduser()
            if not path.is_absolute(): path = Path(cwd) / path
            try:
                path = path.resolve()
                result.append({"repo": "@files", "path": str(path)} if path.is_file() else None)
            except (OSError, ValueError): result.append(None)
        return result

    def files(self, workspace, repo, directory="", **_):
        r = {"path": self.ws(workspace)["path"]} if repo in ("@workspace", "@files") else self.attachment(workspace, repo)
        if repo == "@files":
            path = Path(directory)
            if not path.is_absolute(): raise ValueError("Directory must be absolute")
        else: path = within(r["path"], directory)
        entries = []
        with os.scandir(path) as it:
            for item in it:
                if item.name == ".git": continue
                entries.append({"name": item.name, "path": str(Path(directory) / item.name), "directory": item.is_dir(follow_symlinks=False), "symlink": item.is_symlink()})
                if len(entries) >= 2000: break
        entries.sort(key=lambda e: (not e["directory"], e["name"].lower()))
        return {"entries": entries, "limited": len(entries) >= 2000}

    def file(self, workspace, repo, path, **_):
        if repo == "@files":
            self.ws(workspace)
            p = Path(path).expanduser()
            if not p.is_absolute(): raise ValueError("File link must be absolute")
        else:
            r = {"path": self.ws(workspace)["path"]} if repo == "@workspace" else self.attachment(workspace, repo)
            p = within(r["path"], path)
        if not p.is_file(): raise ValueError("Not a regular file")
        with p.open("rb") as f: raw = f.read(MAX_TEXT + 1)
        if b"\0" in raw[:8192]: return {"text": "Binary file", "binary": True, "truncated": False}
        try: decoded = raw[:MAX_TEXT].decode("utf-8")
        except UnicodeDecodeError: return {"text": "Unsupported encoding", "binary": True, "truncated": False}
        return {"text": decoded, "version": hashlib.sha256(raw).hexdigest(), "truncated": len(raw) > MAX_TEXT, "binary": False}

    def file_save(self, workspace, repo, path, text, version, **_):
        if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_TEXT:
            raise ValueError("File exceeds the 2 MB editing limit")
        with self.lock():
            current = self.file(workspace, repo, path)
            if current.get("binary") or current.get("truncated"):
                raise ValueError("This file cannot be edited as UTF-8 text")
            if not version or current.get("version") != version:
                raise ValueError("File changed on disk. Your draft is preserved; reopen after discarding it to load the latest version.")
            p = Path(self.file_info(workspace, repo, path)["absolutePath"])
            raw = text.encode("utf-8")
            # Preserve the inode, permissions and existing worktree symlinks.
            with p.open("r+b") as stream:
                if hashlib.sha256(stream.read()).hexdigest() != version:
                    raise ValueError("File changed on disk; save cancelled")
                stream.seek(0); stream.write(raw); stream.truncate(); stream.flush(); os.fsync(stream.fileno())
            return {"text": text, "version": hashlib.sha256(raw).hexdigest(), "binary": False, "truncated": False}

    def diff(self, workspace, repo, path="", scope="working", **_):
        r = self.attachment(workspace, repo)
        if path: within(r["path"], path)
        args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"]
        if scope == "staged": args += ["--cached"]
        elif scope == "branch": args += [ref(r.get("base", "HEAD")) + "...HEAD"]
        elif scope != "working": raise ValueError("Unknown diff scope")
        args += ["--"] + ([path] if path else [])
        raw, truncated = limited_diff(r["path"], args)
        if not raw and path and scope == "working":
            tracked = git(r["path"], "ls-files", "-z", "--", path)
            if not tracked:
                return {**self.file(workspace, repo, path), "untracked": True}
        return {"text": raw.decode(errors="replace"), "truncated": truncated, "untracked": False}

    def diff_content(self, workspace, repo, path, scope="working", comparison_ref=None, **_):
        r = self.attachment(workspace, repo)
        within(r["path"], path)
        if scope not in ("working", "staged", "comparison"): raise ValueError("Unsupported diff scope")
        status = {"files": []} if scope == "comparison" else self.status_one(r, compare=False)
        row = next((f for f in status["files"] if f["path"] == path), {})
        def blob(spec):
            size = text(git(r["path"], "cat-file", "-s", spec, ok=(0, 128)))
            if not size: return b""
            if int(size) > MAX_TEXT: return b" " * (MAX_TEXT + 1)
            return git(r["path"], "show", spec)
        if scope == "comparison":
            selected = comparison_ref or self.ws(workspace).get("comparisonRefs", {}).get(repo, "auto")
            _, commit = self.comparison_target(r, selected)
            original = blob(commit + ":" + path)
        else: original = blob(("HEAD:" if scope == "staged" else ":") + ((row.get("original") or path) if scope == "staged" else path))
        if scope == "staged": modified = blob(":" + path)
        else:
            p = within(r["path"], path)
            with p.open("rb") if p.is_file() else contextlib.nullcontext(None) as f:
                modified = f.read(MAX_TEXT + 1) if f else b""
        if b"\0" in original[:8192] or b"\0" in modified[:8192]:
            return {"original": "Binary file", "modified": "Binary file", "binary": True, "truncated": False}
        return {"original": original[:MAX_TEXT].decode(errors="replace"), "modified": modified[:MAX_TEXT].decode(errors="replace"), "binary": False, "truncated": max(len(original), len(modified)) > MAX_TEXT}

    def git_action(self, workspace, repo, action, path="", message="", **_):
        with self.lock():
            r = self.attachment(workspace, repo)
            if path: within(r["path"], path)
            paths = [path]
            if path and action in ("stage", "unstage"):
                current = parse_status(git(r["path"], "status", "--porcelain=v2", "-z", "--untracked-files=no"))
                rename = next((f for f in current["files"] if f["path"] == path and f.get("original")), None)
                if rename: paths.append(rename["original"])
            if action == "stage":
                if not path: raise ValueError("Select a file to stage")
                git(r["path"], "add", "--", *paths)
            elif action == "unstage":
                if not path: raise ValueError("Select a file to unstage")
                git(r["path"], "restore", "--staged", "--", *paths)
            elif action == "commit":
                if not message.strip(): raise ValueError("Enter a commit message")
                git(r["path"], "commit", "-m", message, timeout=120)
            else: raise ValueError("Unsupported Git action")
        return self.status_one(r)

    def linear_issue(self, ticket):
        ticket = ticket.strip()
        if ticket.lower().startswith(("https://", "http://")):
            url = urlsplit(ticket)
            match = re.fullmatch(r"/[^/]+/issue/([A-Za-z][A-Za-z0-9]*-\d+)(?:/[^/]*)?/?", unquote(url.path))
            if url.scheme != "https" or url.hostname != "linear.app" or url.username or url.password or url.port or not match:
                raise ValueError("Paste a Linear issue URL (https://linear.app/team/issue/ENG-123/title) or ticket ID")
            ticket = match[1]
        ticket = ticket.upper()
        if not re.fullmatch(r"[A-Z][A-Z0-9]*-\d+", ticket):
            raise ValueError("Use a Linear issue URL or ticket ID such as ENG-123")
        if not shutil.which("linear"):
            raise ValueError("Linear CLI missing on this host. Install schpet/linear-cli and run linear auth login on this host.")
        try:
            raw = run(["linear", "issue", "view", ticket, "--json", "--no-comments"], cwd=self.root, timeout=15,
                      env=dict(os.environ, NO_COLOR="1", CI="1"))
            issue = json.loads(raw)
        except Exception:
            raise ValueError("Linear could not load this issue. Check the ticket ID and run linear auth login on this host.") from None
        if not isinstance(issue, dict) or issue.get("identifier", "").upper() != ticket:
            raise ValueError("Linear returned an unexpected issue")
        state = issue.get("state")
        if not isinstance(state, dict) or not state.get("name") or not isinstance(issue.get("title"), str):
            raise ValueError("Linear CLI returned incomplete issue details. Update schpet/linear-cli.")
        url = issue.get("url", "")
        if not isinstance(url, str) or not url.startswith("https://linear.app/"):
            raise ValueError("Linear returned an invalid issue URL")
        return {"identifier": ticket, "title": issue["title"], "url": url,
                "state": {"name": state["name"], "type": state.get("type"),
                          "color": state.get("color") if re.fullmatch(r"#[0-9a-fA-F]{6}", str(state.get("color", ""))) else None}}

    def ticket_attach(self, workspace, ticket, **_):
        self.ws(workspace)
        issue = self.linear_issue(ticket) if ticket and ticket.strip() else None
        with self.lock():
            ws = self.ws(workspace)
            ws["ticket"] = issue["identifier"] if issue else None
            self.save_ws(ws)
        self.cache.clear()
        return ws

    def integrations(self, workspace, force=False, **_):
        ws = self.ws(workspace)
        key = (workspace, ws.get("ticket"), tuple(r["id"] for r in ws["repos"]))
        cached = self.cache.get(key)
        if cached and not force and time.monotonic() - cached[0] < 60: return cached[1]
        def pr(r):
            try:
                branch = text(git(r["path"], "branch", "--show-current"))
                raw = run(["gh", "pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "number,title,url,state,isDraft,statusCheckRollup"], cwd=r["path"], timeout=12)
                return {"repo": r["id"], "prs": json.loads(raw), "error": None}
            except Exception as e: return {"repo": r["id"], "prs": [], "error": str(e)}
        prs = list(POOL.map(pr, ws["repos"]))
        ticket = {"id": ws.get("ticket"), "issue": None, "error": None}
        if ws.get("ticket"):
            try: ticket["issue"] = self.linear_issue(ws["ticket"])
            except Exception as e: ticket["error"] = str(e)
        result = {"prs": prs, "ticket": ticket, "at": time.time()}
        self.cache[key] = (time.monotonic(), result)
        return result

    def dispatch(self, op, args=None):
        allowed = {"repo_inventory", "repo_compare", "terminal_run", "terminal_read", "terminal_send", "resolve_links", "file_info", "terminal_cwd", "terminal_split", "terminal_resize", "terminal_reorder", "workspace_reorder", "snapshot", "changes", "terminal_state", "preferences_get", "preferences_set", "host_add", "host_update", "host_remove", "repo_register", "branches", "workspace_create", "repo_attach", "workspace_archive", "workspace_rename", "terminal_rename", "terminal_new", "terminal_prepare", "terminal_remove", "status", "files", "file", "file_save", "diff", "diff_content", "git_action", "ticket_attach", "integrations", "install_cli"}
        if op not in allowed: raise ValueError("Unknown operation: " + op)
        return getattr(self, op)(**(args or {}))


def pty_host(log_path, pid_path, argv):
    """Runs under dtach: relays bytes between dtach's pty and the shell's pty, logging output for replay and `terminal read`."""
    import pty, select, signal, struct, termios, tty
    pid, master = pty.fork()
    if pid == 0:
        with contextlib.suppress(OSError): os.execvp(argv[0], argv)
        os._exit(127)
    def record(cols=0, rows=0):
        atomic_text(Path(pid_path), f"{os.getpid()} {pid} {cols} {rows}\n")
    def sync_size(*_):
        try:
            size = fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8)
            rows, cols = struct.unpack("HH", size[:4])
            if not rows or not cols: rows, cols, size = 24, 80, struct.pack("HHHH", 24, 80, 0, 0)
            fcntl.ioctl(master, termios.TIOCSWINSZ, size)
            record(cols, rows)
            # dtach's redraw signal must reach the app even when the size is unchanged.
            os.killpg(os.tcgetpgrp(master), signal.SIGWINCH)
        except OSError: pass
    def stop(*_): raise SystemExit(0)
    record()
    with contextlib.suppress(termios.error): tty.setraw(0)
    sync_size()
    signal.signal(signal.SIGWINCH, sync_size)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)
    log = open(log_path, "ab", buffering=0)
    written, inputs = log.tell(), [0, master]
    try:
        while True:
            ready = select.select(inputs, [], [])[0]
            if master in ready:
                try: data = os.read(master, 65536)
                except OSError: data = b""
                if not data: break
                with contextlib.suppress(OSError): write_fd(1, data)
                log.write(data)
                written += len(data)
                if written > LOG_MAX:
                    log.close()
                    keep = tail_bytes(log_path, LOG_KEEP)
                    Path(log_path).write_bytes(keep)
                    log, written = open(log_path, "ab", buffering=0), len(keep)
            if 0 in ready:
                data = os.read(0, 65536)
                if data: write_fd(master, data)
                else: inputs.remove(0)
    finally:
        os.close(master)
        for _ in range(20):
            with contextlib.suppress(ChildProcessError):
                if os.waitpid(pid, os.WNOHANG)[0]: break
            time.sleep(.1)


def write_fd(fd, data):
    while data: data = data[os.write(fd, data):]


def atomic_text(path, value):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(value)
    os.replace(tmp, path)


def attach_session(sock, log_path):
    """Replays recent output into the fresh xterm, then hands the pty to dtach."""
    write_fd(1, TERMINAL_QUERY.sub(b"", tail_bytes(log_path, REPLAY_BYTES)))
    os.execvp("dtach", ["dtach", "-a", sock, "-E", "-z", "-r", "winch"])


def rpc(backend):
    for line in sys.stdin:
        try:
            request = json.loads(line)
            result = {"ok": True, "data": backend.dispatch(request["op"], request.get("args"))}
        except Exception as e: result = {"ok": False, "error": str(e)}
        print(json.dumps(result), flush=True)


def main():
    if sys.argv[1:2] == ["--pty-host"] and len(sys.argv) > 5 and sys.argv[4] == "--": return pty_host(sys.argv[2], sys.argv[3], sys.argv[5:])
    if sys.argv[1:2] == ["--attach"] and len(sys.argv) == 4: return attach_session(sys.argv[2], sys.argv[3])
    parser = argparse.ArgumentParser(description="Relay — multi-repo agent workspaces", epilog="Commands: workspace list/create/rename/archive; repo register/attach/list/compare; terminal new/run/read/send/remove/split/rename; ticket attach; host add. Run a persistent command with: relay --workspace ID terminal run --name Review --command 'codex' --json. Read output: relay --workspace ID terminal read --terminal ID --json. Send input: terminal send --terminal ID --input-text TEXT [--enter]. Relay does not implement Orca orchestration or orca-ide.")
    parser.add_argument("--version", action="version", version="Relay " + VERSION)
    parser.add_argument("--root", default=os.environ.get("RELAY_ROOT") or os.environ.get("MAGI_ROOT"))
    parser.add_argument("--workspace", default=os.environ.get("RELAY_WORKSPACE") or os.environ.get("MAGI_WORKSPACE"))
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--rpc", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("words", nargs="*")
    # Options after subcommands are parsed separately, preserving conventional CLI syntax.
    args, extras = parser.parse_known_args()
    if args.rpc: return rpc(Backend(args.root))
    sub = argparse.ArgumentParser(add_help=False)
    for opt in ("ref", "repo", "branch", "new-branch", "base", "path", "url", "name", "terminal", "axis", "host", "ssh", "new-name", "cwd", "scope", "directory", "message", "command", "input-text", "lines"):
        sub.add_argument("--" + opt)
    for opt in ("blank", "utility", "enter"):
        sub.add_argument("--" + opt, action="store_true")
    options = vars(sub.parse_args(extras))
    options = {k: v for k, v in options.items() if v is not None and v is not False}
    words = args.words
    if not words: parser.print_help(); return
    backend = Backend(args.root)
    commands = {("repo", "compare"): "repo_compare", ("terminal", "run"): "terminal_run", ("terminal", "read"): "terminal_read", ("terminal", "send"): "terminal_send", ("terminal", "remove"): "terminal_remove", ("terminal", "split"): "terminal_split",("workspace", "rename"): "workspace_rename", ("terminal", "rename"): "terminal_rename", ("workspace", "list"): "snapshot", ("workspace", "create"): "workspace_create", ("workspace", "archive"): "workspace_archive", ("repo", "register"): "repo_register", ("repo", "attach"): "repo_attach", ("repo", "list"): "snapshot", ("terminal", "new"): "terminal_new", ("ticket", "attach"): "ticket_attach", ("host", "add"): "host_add", ("host", "update"): "host_update", ("host", "remove"): "host_remove"}
    op = commands.get(tuple(words[:2]), words[0])
    positional = words[2:]
    if args.workspace: options["workspace"] = args.workspace
    if op == "workspace_create":
        if positional: options["name"] = " ".join(positional)
        if "repo" in options:
            options["repos"] = [{"repo": r} for r in options.pop("repo").split(",")]
    elif op in ("repo_attach", "repo_compare") and positional: options["repo"] = positional[0]
    elif op == "repo_register" and positional: options["path"] = positional[0]
    elif op == "ticket_attach" and positional: options["ticket"] = positional[0]
    elif op == "host_add" and positional: options["name"] = positional[0]
    elif op in ("host_remove", "host_update") and positional: options["name"] = positional[0]
    if "ref" in options: options["comparison_ref"] = options.pop("ref")
    host = options.pop("host", "local")
    try:
        if host != "local":
            h = next((h for h in backend.config()["hosts"] if h["name"] == host), None)
            if not h: raise ValueError("Host is not registered: " + host)
            bootstrap = """import sys,json,os
from pathlib import Path
p=json.loads(sys.stdin.buffer.raw.readline());r=Path(p['root']).expanduser().resolve();old=r.with_name('magi')
if r.name=='relay' and not r.exists() and old.exists() and not old.is_symlink():
    old.rename(r);old.symlink_to(r,target_is_directory=True)
d=r/'utils'/'relay';previous=r/'utils'/'magi'
if old.is_symlink() and old.resolve()==r and previous.exists() and not previous.is_symlink() and not d.exists():
    previous.rename(d);previous.symlink_to(d,target_is_directory=True)
d.mkdir(parents=True,exist_ok=True)
[(d/k).write_text(v) for k,v in p['files'].items()]
os.execv(sys.executable,[sys.executable,'-u',str(d/'relay.py'),'--root',str(r),'--rpc'])"""
            files = {f: (Path(__file__).parent / f).read_text() for f in ("relay.py", "RELAY-CLI.md")}
            payload = json.dumps({"root": h["root"], "files": files}) + "\n" + json.dumps({"op": op, "args": options}) + "\n"
            p = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", "--", h["ssh"], "python3 -u -c " + shlex.quote(bootstrap)], input=payload, capture_output=True, text=True, timeout=180)
            if p.returncode: raise ValueError(p.stderr.strip() or "SSH backend failed")
            result = json.loads(p.stdout)
            if not result["ok"]: raise ValueError(result["error"])
            data = result["data"]
        else:
            data = backend.dispatch(op, options)
        print(json.dumps({"ok": True, "data": data}, indent=None if args.json else 2))
        if op == "workspace_create" and data.get("errors"): sys.exit(1)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__": main()
