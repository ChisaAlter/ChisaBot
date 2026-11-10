#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ChisaBot 宿主机更新程序（docs/online-update.md）。root 的 systemd 服务 chisabot-updater。

ChisaBot 容器没有 docker socket。它只能往 spool/requests/ 里放请求文件：
    {"id": "...", "action": "check" | "update" | "rollback", "actor": "...", "expectCommit": "<sha>"?}
这个程序每 2 秒取一次，只认这三种动作，从不执行请求里的任何字符串；更新 / 回滚交给同目录的
update.sh / rollback.sh（带锁，同一时间只有一个）。它把状态写进 spool/state/state.json（容器里只读挂载），
管理后台 → 系统更新 读这个文件显示版本、新提交、进度、日志和历史。

更新来源：本机裸仓库 mirror.git，每 30 分钟和点「检查更新」时从 GitHub 拉 main：公开仓库匿名拉取；
有 /opt/chisabot-updater/github-token（root 600，只读令牌）时带令牌拉（私有仓库）。config.env 里
GITHUB_FETCH=off 时不联网，只读本机镜像（由发布者 git push 到这里）。

更新有两种（update.sh 自动选）：依赖没变 → 快速更新（只替换代码层）；依赖或底座变了 → 完整构建
（仓库 Dockerfile 从头构建，限内存），请求里 "mode": "full" 可以强制完整构建。

python3（3.6+，在 3.12 上测试）和 python2.7 都能跑，不依赖第三方包：服务优先用 python3，没有（或太旧）时用
python2（deploy/updater/install.sh 写进 systemd unit）。兼容 CentOS 7 的 python2.7 / git 1.8。
自测：python3 deploy/updater/test_updater.py（python2 同样可以）。

自升级：一次更新成功后 update.sh 用新提交里的 deploy/updater/install.sh --scripts-only 换掉本目录的脚本；
这个进程发现自己的文件变了，等手上没有任务时重新 exec 自己（不需要 systemctl restart）。
"""
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta

U = os.environ.get("CHISABOT_UPDATER_HOME") or "/opt/chisabot-updater"
SPOOL = os.path.join(U, "spool")
REQ = os.path.join(SPOOL, "requests")
STATE_DIR = os.path.join(SPOOL, "state")
STATE_FILE = os.path.join(STATE_DIR, "state.json")
INTERNAL = os.path.join(U, "internal.json")
JOBS = os.path.join(U, "jobs")
AUDIT = os.path.join(U, "audit.log")
MIRROR = os.path.join(U, "mirror.git")
TOKEN_FILE = os.path.join(U, "github-token")
BASE_ENV = os.path.join(U, "base.env")
# 和 server 的 SYSTEM_UPDATE_UPDATER_VERSION（shared/system-update.ts）一起改：页面据此提示「更新程序是旧版本」。
VERSION = "4"
PUBLIC_HEALTH_EXAMPLE = "chisabot.example.com"

try:
    TEXT_TYPES = (basestring,)  # noqa: F821  (python2)
except NameError:
    TEXT_TYPES = (str, bytes)
PY2 = sys.version_info[0] == 2

ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,64}$")
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{6,64}\.json$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
# ANSI 颜色序列要先整段去掉，否则只去掉 ESC、留下 "[31m"。
CTRL_RE = re.compile(u"\x1b\\[[0-9;]*[A-Za-z]|[\x00-\x08\x0b-\x1f\x7f]")
ACTIONS = ("check", "update", "rollback", "magpie")

CHECK_EVERY = 30 * 60
# 自托管 Magpie 的镜像摘要检查：只查 registry 的 manifest，不拉镜像、不碰容器，所以不占更新锁。
MAGPIE_CHECK_EVERY = 30 * 60
REFRESH_EVERY = 30


def utcnow():
    """naive UTC datetime（datetime.utcnow 在 3.12 起弃用）。"""
    return datetime(*time.gmtime()[:6])


def now_iso():
    return utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def load_config():
    """config.env，再叠上完整构建后写的 base.env（BASE_IMAGE / NODE_MODULES_BASE）。"""
    cfg = {}
    for path in (os.path.join(U, "config.env"), BASE_ENV):
        try:
            with open_text(path) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    cfg[k.strip()] = v.strip().strip('"')
        except IOError:
            if path != BASE_ENV:
                raise
    return cfg




def run(args, timeout=60, env=None):
    """返回 (code, stdout)。stderr 并进 stdout。"""
    # 先等退出再读 PIPE 会让输出超过管道容量的命令永久阻塞。临时文件同时兼容
    # Python 2.7，并让超时轮询与命令输出互不阻塞。
    with tempfile.TemporaryFile() as output:
        p = subprocess.Popen(args, stdout=output, stderr=subprocess.STDOUT, env=env)
        deadline = time.time() + timeout
        while p.poll() is None:
            if time.time() > deadline:
                try:
                    p.kill()
                except OSError:
                    pass
                p.wait()
                return 124, "超时"
            time.sleep(0.1)
        output.seek(0)
        return p.returncode, output.read().decode("utf-8", "replace")


def git(*args):
    return run(["git", "--git-dir=" + MIRROR] + list(args), timeout=120)


def clean(text, limit=400):
    if not isinstance(text, TEXT_TYPES):
        return ""
    if isinstance(text, bytes):
        text = text.decode("utf-8", "replace")
    return CTRL_RE.sub(u"", text).strip()[:limit]


def write_json(path, data, mode=0o644):
    # 后台检查和主循环会同时保存状态；各用独立临时文件，再原子替换同一目标。
    fd, tmp = tempfile.mkstemp(prefix=os.path.basename(path) + ".", suffix=".tmp",
                               dir=os.path.dirname(os.path.abspath(path)))
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, ensure_ascii=True, indent=1)
        os.chmod(tmp, mode)
        getattr(os, "replace", os.rename)(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def audit(entry):
    entry = dict(entry)
    entry["at"] = now_iso()
    line = json.dumps(entry, ensure_ascii=False)
    if not isinstance(line, bytes):
        line = line.encode("utf-8")
    with open(AUDIT, "ab") as f:
        f.write(line + b"\n")


def open_text(path):
    """文本文件（config.env、compose 里有中文注释，请求里的名字可能是中文）：python3 下不受 locale 影响。"""
    if PY2:
        return open(path)
    return io.open(path, encoding="utf-8", errors="replace")


def read_text(path):
    with io.open(path, "rb") as f:
        return f.read().decode("utf-8", "replace")


CFG = load_config()


class Updater(object):
    def __init__(self):
        self.lock = threading.Lock()
        self.internal = {"job": None, "history": [], "source": None}
        try:
            with open(INTERNAL) as f:
                self.internal.update(json.load(f))
        except (IOError, ValueError):
            pass
        self.child = None
        self.snapshot = {}
        self.last_refresh = 0
        self.last_check = 0
        self.last_magpie_check = 0
        self.magpie_checking = False
        self.checking = False

    # ---------- 持久化 ----------
    def save_internal(self):
        write_json(INTERNAL, self.internal, 0o600)

    def add_history(self, job, status, error=None):
        entry = {
            "id": job["id"],
            "action": job["action"],
            "status": status,
            "at": now_iso(),
            "actor": job.get("actor"),
        }
        for k in ("fromImage", "toImage", "targetCommit", "mode", "durationSec"):
            if job.get(k):
                entry["commit" if k == "targetCommit" else k] = job[k]
        if error:
            entry["error"] = error
        self.internal["history"] = ([entry] + self.internal.get("history", []))[:30]

    def estimates(self):
        """最近一次成功的快速 / 完整更新各用了多少秒（页面上显示「预计约 N 分钟」）。"""
        out = {}
        for h in self.internal.get("history", []):
            if h.get("action") != "update" or h.get("status") != "succeeded" or not h.get("durationSec"):
                continue
            mode = h.get("mode") or "code"
            if mode in ("code", "full") and mode not in out:
                out[mode] = h["durationSec"]
        return out

    # ---------- 来源 ----------
    def fetch(self):
        """从 GitHub 拉 main 到本机镜像（公开仓库匿名，有令牌时带令牌）；GITHUB_FETCH=off 时只读本机镜像。"""
        global CFG
        CFG = load_config()
        repo = CFG.get("GITHUB_REPO", "ChisaAlter/ChisaBot")
        branch = CFG.get("GITHUB_BRANCH", "main")
        source = {"repo": repo, "branch": branch, "fetchedAt": now_iso()}
        if not re.match(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", repo) or not re.match(r"^[A-Za-z0-9_./-]+$", branch):
            source["kind"] = "mirror"
            source["error"] = u"config.env 里的 GITHUB_REPO / GITHUB_BRANCH 格式不对"
            return source
        if CFG.get("GITHUB_FETCH", "auto").lower() in ("off", "no", "0", "false"):
            source["kind"] = "mirror"
            return source
        source["kind"] = "github"
        env = dict(os.environ)
        env["GIT_TERMINAL_PROMPT"] = "0"
        token = os.path.isfile(TOKEN_FILE) and os.path.getsize(TOKEN_FILE) > 0
        if token:
            env["GIT_ASKPASS"] = os.path.join(U, "git-askpass.sh")
            url = "https://x-access-token@github.com/%s.git" % repo
        else:
            url = "https://github.com/%s.git" % repo
        if not os.path.isdir(MIRROR):
            run(["git", "init", "--bare", "-q", MIRROR], timeout=30)
        code, out = run(
            ["git", "--git-dir=" + MIRROR, "fetch", "--quiet", "--no-tags", url,
             "+refs/heads/%s:refs/heads/main" % branch],
            timeout=180, env=env)
        if code != 0:
            hint = u"" if token else u"（私有仓库请放只读令牌 github-token，或在 config.env 设 GITHUB_FETCH=off 改为推送到本机镜像）"
            source["error"] = u"从 GitHub 拉取失败：" + clean(out.replace("\n", " "), 200) + hint
        return source

    # ---------- 状态 ----------
    def current(self):
        c = CFG["CONTAINER"]
        code, image = run(["docker", "inspect", "-f", "{{.Config.Image}}", c], timeout=20)
        if code != 0:
            return None
        image = image.strip()
        _, commit = run(["docker", "image", "inspect", "-f", '{{index .Config.Labels "chisabot.commit"}}', image], timeout=20)
        _, started = run(["docker", "inspect", "-f", "{{.State.StartedAt}}", c], timeout=20)
        cur = {"image": image}
        commit = commit.strip()
        if SHA_RE.match(commit):
            cur["commit"] = commit
        started = started.strip()[:19]
        if re.match(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$", started):
            cur["deployedAt"] = started + "Z"
        return cur

    def previous(self, cur):
        if not cur:
            return None
        tag = cur["image"].split(":")[-1]
        # deploy/start.sh 部署（env 模式，见 compose-image.sh）：上一版镜像名记在 .image.before-<标签>。
        image_file = os.path.join(CFG["COMPOSE_DIR"], ".image.before-%s" % tag)
        before = os.path.join(CFG["COMPOSE_DIR"], "%s.before-%s" % (CFG["COMPOSE_FILE"], tag))
        pattern = r"^    image: (%s:[A-Za-z0-9._-]+)\s*$" % re.escape(CFG["IMAGE_REPO"])
        if os.path.exists(image_file):
            before = image_file
            pattern = r"^(%s:[A-Za-z0-9._-]+)\s*$" % re.escape(CFG["IMAGE_REPO"])
        try:
            with open_text(before) as f:
                for line in f:
                    m = re.match(pattern, line)
                    if m:
                        prev = {"image": m.group(1)}
                        code, commit = run(["docker", "image", "inspect", "-f", '{{index .Config.Labels "chisabot.commit"}}', prev["image"]], timeout=20)
                        if code != 0:
                            return None  # 镜像已删，不能回滚
                        if SHA_RE.match(commit.strip()):
                            prev["commit"] = commit.strip()
                        return prev
        except IOError:
            return None
        return None

    def commits(self, cur):
        code, main = git("rev-parse", "refs/heads/main")
        main = main.strip()
        if code != 0 or not SHA_RE.match(main):
            return None, None, [], False, None

        def parse(out):
            items = []
            for line in out.splitlines():
                parts = line.split("\x1f")
                if len(parts) != 4 or not SHA_RE.match(parts[0]):
                    continue
                date = parts[3].strip()
                try:
                    d = datetime.strptime(date[:19], "%Y-%m-%d %H:%M:%S")
                    sign = 1 if date[20] == "+" else -1
                    off = sign * (int(date[21:23]) * 60 + int(date[23:25]))
                    iso = (d - timedelta(minutes=off)).strftime("%Y-%m-%dT%H:%M:%SZ")
                except (ValueError, IndexError):
                    iso = None
                item = {"sha": parts[0], "subject": clean(parts[1], 200), "author": clean(parts[2], 80)}
                if iso:
                    item["date"] = iso
                items.append(item)
            return items

        fmt = "--format=%H%x1f%s%x1f%an%x1f%ai"
        _, head = git("log", "-1", fmt, main)
        latest = (parse(head) or [None])[0]
        behind = None
        items = []
        if cur and cur.get("commit"):
            code, _ = git("cat-file", "-e", cur["commit"] + "^{commit}")
            if code == 0:
                _, out = git("log", fmt, "-50", "%s..%s" % (cur["commit"], main))
                items = parse(out)
                _, n = git("rev-list", "--count", "%s..%s" % (cur["commit"], main))
                try:
                    behind = int(n.strip())
                except ValueError:
                    behind = len(items)
        code, fp = run(["bash", os.path.join(U, "deps-fingerprint.sh"), main], timeout=30)
        try:
            base = open(os.path.join(U, "base-deps.sha256")).read().strip()
        except IOError:
            base = ""
        reason = None
        if not base:
            reason = u"这台服务器还没有快速更新用的底座（第一次一键更新），完整构建一次之后，依赖不变的更新只替换代码"
        elif code == 0 and fp.strip() != base:
            reason = u"这些提交改动了依赖（bun.lock / package.json）、Dockerfile 或 docker/"
        else:
            image = CFG.get("BASE_IMAGE", "")
            if not image or run(["docker", "image", "inspect", image], timeout=20)[0] != 0:
                reason = u"快速更新用的底座镜像 %s 不在了" % (image or u"（未配置）")
            elif not os.path.isdir(CFG.get("NODE_MODULES_BASE", "/nonexistent")):
                reason = u"快速更新用的依赖树不在了"
        if not (cur and cur.get("commit")):
            # 镜像没有 chisabot.commit 标签（例如 deploy/start.sh 第一次构建的）：不知道落后多少，完整构建一次就有了。
            return main, latest, items, u"当前镜像没有记录来源提交，完整构建一次之后就能按提交快速更新", behind
        deps_changed = bool(behind) and reason is not None
        return main, latest, items, (reason if deps_changed else None), behind

    def warnings(self):
        """配置上的问题（页面显示成提示，不阻止更新）。只给代号，文字在前端。"""
        out = []
        url = CFG.get("PUBLIC_HEALTH_URL", "")
        if not url:
            out.append("health_url_missing")
        elif PUBLIC_HEALTH_EXAMPLE in url:
            out.append("health_url_example")
        if not os.path.isfile(os.path.join(CFG.get("COMPOSE_DIR", "/nonexistent"), CFG.get("COMPOSE_FILE", "compose.yaml"))):
            out.append("compose_missing")
        if run(["docker", "buildx", "version"], timeout=20)[0] != 0:
            out.append("buildx_missing")
        return out

    def refresh(self):
        cur = self.current()
        main, latest, items, deps, behind = self.commits(cur)
        with self.lock:
            self.snapshot = {
                "current": cur,
                "previous": self.previous(cur),
                "main": main,
                "latest": latest,
                "commits": items,
                "behind": behind,
                "depsChanged": bool(deps),
                "fullReason": deps,
                "warnings": self.warnings(),
            }
            if cur and cur.get("commit") and main == cur["commit"]:
                self.snapshot["behind"] = 0
            self.snapshot["externalBusy"] = not self.busy() and self.lock_held()
            self.last_refresh = time.time()
        self.write_state()

    def write_state(self):
        with self.lock:
            snap = dict(self.snapshot)
            job = self.internal.get("job")
            state = {
                "updaterVersion": VERSION,
                "updatedAt": now_iso(),
                "current": snap.get("current"),
                "previous": snap.get("previous"),
                "source": self.internal.get("source"),
                "latest": snap.get("latest"),
                "behind": snap.get("behind"),
                "commits": snap.get("commits") or [],
                "depsChanged": bool(snap.get("depsChanged")),
                "fullReason": snap.get("fullReason"),
                "warnings": snap.get("warnings") or [],
                "python": "%d.%d" % sys.version_info[:2],
                "estimates": self.estimates(),
                "externalBusy": bool(snap.get("externalBusy")),
                "job": job,
                "history": self.internal.get("history", []),
            }
        write_json(STATE_FILE, state)

    # ---------- 请求 ----------
    def reject(self, req, reason):
        entry = {"id": req.get("id", "unknown-" + str(int(time.time()))), "action": req.get("action", "check"),
                 "actor": clean(req.get("actor", ""), 80)}
        self.add_history(entry, "rejected", reason)
        audit({"event": "request_rejected", "id": entry["id"], "action": entry["action"], "actor": entry["actor"], "reason": reason})
        self.save_internal()
        self.write_state()

    def take_requests(self):
        try:
            names = sorted(os.listdir(REQ))
        except OSError:
            return
        for name in names:
            path = os.path.join(REQ, name)
            if not NAME_RE.match(name):
                continue
            try:
                if os.path.getsize(path) > 4096:
                    raise ValueError("too big")
                with open_text(path) as f:
                    req = json.load(f)
            except (IOError, OSError, ValueError):
                req = None
            try:
                os.unlink(path)
            except OSError:
                pass
            if not isinstance(req, dict) or req.get("action") not in ACTIONS or not ID_RE.match(str(req.get("id", ""))):
                continue
            self.handle(req)

    def busy(self):
        job = self.internal.get("job")
        return bool(job and job.get("status") in ("queued", "running"))

    def handle(self, req):
        action = req["action"]
        actor = clean(req.get("actor", ""), 80)
        if action == "check":
            self.start_check()
            # 「检查更新」也顺手刷一次 Magpie 的镜像摘要，否则页面上的「有没有新版」要等下一个 30 分钟。
            self.start_magpie_check()
            return
        # 上一轮脚本已经退出时，先记下结果再决定能不能接新请求。
        # 否则健康检查刚失败、poll 还没跑到，立刻重试会被拒「已经有一个更新或回滚在进行」。
        self.poll_job()
        if self.busy():
            job = self.internal.get("job") or {}
            if job.get("action") == "magpie":
                return self.reject(req, u"上一轮 Magpie 安装还在进行，等它结束后即可重试（已生成的密钥会保留）")
            return self.reject(req, u"已经有一个更新或回滚在进行")
        if self.lock_held():
            return self.reject(req, u"宿主机上有人正在手动运行更新或回滚，等它结束再试")
        self.refresh()
        snap = self.snapshot
        if action == "update":
            main = snap.get("main")
            if not main:
                return self.reject(req, u"本机镜像里没有 main")
            expect = req.get("expectCommit")
            if expect and expect != main:
                return self.reject(req, u"main 已经变了（现在是 %s），请刷新页面后重试" % main[:7])
            full = req.get("mode") == "full" or not (snap.get("current") or {}).get("commit")
            if snap.get("current", {}) and snap["current"].get("commit") == main and not full:
                return self.reject(req, u"已经是最新版本")
            args = ["/bin/bash", os.path.join(U, "update.sh"), "--job", req["id"], "--target", main]
            if full:
                args.append("--full")
            mode = "full" if (full or snap.get("depsChanged")) else "code"
            job = {"id": req["id"], "action": "update", "status": "running", "step": "prepare", "startedAt": now_iso(),
                   "actor": actor, "targetCommit": main, "mode": mode, "log": []}
        elif action == "magpie":
            # 自托管模型网关的原地更新（管理后台 → 模型平台 Magpie）。和 ChisaBot 更新共用一把锁：
            # 两者都动 docker，不能同时跑。
            script = os.path.join(U, "magpie.sh")
            if not os.path.exists(script):
                return self.reject(req, u"宿主机上的更新程序还没有 magpie.sh；先做一次「系统更新」把更新程序升上来")
            args = ["/bin/bash", script, "--update", "--job", req["id"]]
            job = {"id": req["id"], "action": "magpie", "status": "running", "step": "prepare", "startedAt": now_iso(),
                   "actor": actor, "log": []}
        else:
            if not snap.get("previous"):
                return self.reject(req, u"没有可以回滚到的上一版")
            args = ["/bin/bash", os.path.join(U, "rollback.sh"), "--job", req["id"]]
            job = {"id": req["id"], "action": "rollback", "status": "running", "step": "prepare", "startedAt": now_iso(),
                   "actor": actor, "log": []}
        audit({"event": "job_started", "id": job["id"], "action": action, "actor": actor, "target": job.get("targetCommit")})
        log = open(os.path.join(JOBS, job["id"] + ".log"), "w")
        # 自己一个会话：服务重启（KillMode=process）时更新脚本不会被一起杀掉。
        self.child = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT, preexec_fn=os.setsid, close_fds=True)
        with self.lock:
            self.internal["job"] = job
        self.save_internal()
        self.write_state()

    def start_check(self):
        if self.checking:
            return
        self.checking = True

        def work():
            try:
                source = self.fetch()
                with self.lock:
                    self.internal["source"] = source
                self.save_internal()
                self.last_check = time.time()
                self.refresh()
            finally:
                self.checking = False

        t = threading.Thread(target=work)
        t.daemon = True
        t.start()

    def start_magpie_check(self):
        """查一次自托管 Magpie 的镜像摘要，写 spool/state/magpie.json。

        页面（管理后台 → 模型平台 Magpie）据此显示「有没有新版」。只读：buildx imagetools / docker
        manifest，不拉镜像、不碰容器，所以不拿更新锁，也不会打断正在跑的一轮对话。
        """
        if self.magpie_checking:
            return
        self.magpie_checking = True

        def work():
            try:
                script = os.path.join(U, "magpie.sh")
                if os.path.exists(script):
                    run(["/bin/bash", script, "--check"], timeout=120)
            except Exception as error:  # 一次查不到不该让守护进程有意见
                sys.stderr.write("chisabot-updater: magpie check %r\n" % (error,))
                sys.stderr.flush()
            finally:
                self.magpie_checking = False
                self.last_magpie_check = time.time()

        t = threading.Thread(target=work)
        t.daemon = True
        t.start()

    # ---------- 任务进度 ----------
    def lock_held(self):
        code, _ = run(["flock", "-n", os.path.join(U, "update.lock"), "true"], timeout=10)
        return code != 0

    def poll_job(self):
        job = self.internal.get("job")
        if not job or job.get("status") != "running":
            return
        path = os.path.join(JOBS, job["id"] + ".log")
        try:
            lines = read_text(path).splitlines()
        except IOError:
            lines = []
        result = None
        visible = []
        for line in lines:
            line = clean(line, 400)
            if not line:
                continue
            if line.startswith("::step:: "):
                job["step"] = line[9:].strip()[:20]
            elif line.startswith("::result:: "):
                result = line[11:].strip()
            elif line.startswith("::from:: "):
                job["fromImage"] = line[9:].strip()
            elif line.startswith("::to:: "):
                job["toImage"] = line[7:].strip()
            elif line.startswith("::mode:: "):
                mode = line[9:].strip()
                if mode in ("code", "full"):
                    job["mode"] = mode
            elif line.startswith("::duration:: "):
                try:
                    job["durationSec"] = int(line[13:].strip())
                except ValueError:
                    pass
            elif line.startswith("::error:: "):
                job["error"] = line[10:].strip()[:400]
                visible.append(u"✕ " + line[10:])
            elif line.startswith("::"):
                continue
            else:
                visible.append(line)
        job["log"] = visible[-60:]
        finished = False
        if self.child is not None:
            if self.child.poll() is not None:
                finished = True
                code = self.child.returncode
                self.child = None
                if result is None:
                    result = "succeeded" if code == 0 else ("rolled_back" if code == 3 else "failed")
        elif result is not None or not self.lock_held():
            # 服务重启后接手的任务：脚本跑完（写了 result 或锁已释放）就结束。
            finished = True
            if result is None:
                result = "failed"
                job["error"] = job.get("error") or u"更新程序重启期间任务中断，请查看日志"
        if finished:
            job["status"] = result if result in ("succeeded", "failed", "rolled_back") else "failed"
            job["finishedAt"] = now_iso()
            if not job.get("durationSec"):
                try:
                    started = datetime.strptime(job["startedAt"], "%Y-%m-%dT%H:%M:%SZ")
                    job["durationSec"] = int((utcnow() - started).total_seconds())
                except (KeyError, ValueError):
                    pass
            if job["status"] == "succeeded":
                job.pop("error", None)
            self.add_history(job, job["status"], job.get("error"))
            audit({"event": "job_finished", "id": job["id"], "action": job["action"], "status": job["status"],
                   "from": job.get("fromImage"), "to": job.get("toImage"), "error": job.get("error")})
            self.save_internal()
            self.refresh()
        else:
            self.write_state()

    def upgraded(self):
        """自己的文件被 install.sh 换掉了（自升级）而且手上没有任务：该重新 exec 了。"""
        try:
            stamp = os.stat(SELF).st_mtime
        except OSError:
            return False
        return stamp != SELF_MTIME and not self.busy() and self.child is None and not self.checking

    def loop(self):
        for d in (REQ, STATE_DIR, JOBS):
            if not os.path.isdir(d):
                os.makedirs(d)
        self.start_check()
        while True:
            try:
                if self.upgraded():
                    sys.stderr.write("chisabot-updater: scripts upgraded, re-exec\n")
                    sys.stderr.flush()
                    os.execv(sys.executable, [sys.executable, SELF] + sys.argv[1:])
                # 先收下已结束的任务，再处理新请求：健康检查失败后立刻点「重试」才不会撞上过期的 running。
                self.poll_job()
                self.take_requests()
                if time.time() - self.last_check > CHECK_EVERY:
                    self.start_check()
                if time.time() - self.last_magpie_check > MAGPIE_CHECK_EVERY:
                    self.start_magpie_check()
                if time.time() - self.last_check > CHECK_EVERY or time.time() - self.last_refresh > REFRESH_EVERY:
                    self.refresh()
            except Exception as error:  # 守护进程不因一次异常退出
                sys.stderr.write("chisabot-updater: %r\n" % (error,))
                sys.stderr.flush()
                time.sleep(5)
            time.sleep(2)


SELF = os.path.abspath(__file__)
try:
    SELF_MTIME = os.stat(SELF).st_mtime
except OSError:
    SELF_MTIME = None


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--once":
        u = Updater()
        u.internal["source"] = u.fetch()
        u.save_internal()
        u.refresh()
        print(open(STATE_FILE).read())
    else:
        Updater().loop()
