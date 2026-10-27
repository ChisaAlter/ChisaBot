# -*- coding: utf-8 -*-
"""Quick self-test for chisabot-updater.py under python3 (3.6+) and python2.7. No docker, no root, no network.

    python3 deploy/updater/test_updater.py      # and/or: python2 deploy/updater/test_updater.py

Exercises clean(), audit(), write_json()/write_state() (state.json), poll_job() on a job log with Chinese text
and ::markers::, and the .image.before lookup used by previous(). Exits non-zero on the first failure.
"""
from __future__ import print_function, unicode_literals

import io
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def load(home):
    os.environ["CHISABOT_UPDATER_HOME"] = home
    path = os.path.join(HERE, "chisabot-updater.py")
    if sys.version_info[0] >= 3:
        import importlib.util
        spec = importlib.util.spec_from_file_location("chisabot_updater", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    import imp  # python2
    return imp.load_source("chisabot_updater", path)


def main():
    home = tempfile.mkdtemp(prefix="cbupd-test-")
    try:
        compose_dir = os.path.join(home, "deploy")
        for d in ("spool/requests", "spool/state", "jobs", "deploy"):
            os.makedirs(os.path.join(home, d))
        with io.open(os.path.join(home, "config.env"), "w", encoding="utf-8") as f:
            f.write("# 中文注释：python3 在 C locale 下也要能读\nCOMPOSE_DIR=%s\nCOMPOSE_FILE=compose.yaml\n"
                    "CONTAINER=chisabot-zh\nIMAGE_REPO=local/chisabot\nPUBLIC_HEALTH_URL=\n" % compose_dir)
        m = load(home)

        # clean(): str / bytes / control characters / non-text
        assert m.clean("ok\x1b[31m red\x07") == "ok red", m.clean("ok\x1b[31m red\x07")
        assert m.clean("更新".encode("utf-8")) == "更新"
        assert m.clean(None) == "" and m.clean(5) == ""
        assert m.clean("x" * 500, 10) == "x" * 10

        # audit(): one UTF-8 JSON line per entry, Chinese kept
        m.audit({"event": "job_finished", "error": "健康检查没通过"})
        m.audit({"event": "second"})
        with io.open(m.AUDIT, "r", encoding="utf-8") as f:
            lines = f.read().splitlines()
        assert len(lines) == 2 and json.loads(lines[0])["error"] == "健康检查没通过", lines

        u = m.Updater()
        u.refresh = lambda: u.write_state()  # no docker here
        u.lock_held = lambda: False

        # poll_job(): a finished job log (service restarted mid-job, so no child process)
        job_id = "update-test12345"
        log = "::step:: frontend\n::mode:: code\n构建前端（限内存 3500m）\n::to:: local/chisabot:auto-1\n" \
              "::error:: 前端构建失败 \x1b[31m!\n::duration:: 42\n::result:: failed\n"
        with io.open(os.path.join(home, "jobs", job_id + ".log"), "w", encoding="utf-8") as f:
            f.write(log)
        u.internal["job"] = {"id": job_id, "action": "update", "status": "running", "step": "prepare",
                             "startedAt": m.now_iso(), "actor": "管理员", "log": []}
        u.poll_job()
        job = u.internal["job"]
        assert job["status"] == "failed" and job["step"] == "frontend" and job["mode"] == "code", job
        assert job["toImage"] == "local/chisabot:auto-1" and job["durationSec"] == 42, job
        assert "构建前端（限内存 3500m）" in job["log"] and job["error"].startswith("前端构建失败"), job
        assert u.internal["history"][0]["status"] == "failed"

        # state.json: valid JSON, ASCII-escaped, readable by the server
        u.snapshot = {"warnings": ["health_url_missing"]}
        u.write_state()
        with io.open(m.STATE_FILE, "r", encoding="utf-8") as f:
            state = json.load(f)
        assert state["updaterVersion"] == m.VERSION and state["warnings"] == ["health_url_missing"], state
        assert state["history"][0]["error"].startswith("前端构建失败")
        assert state["python"] == "%d.%d" % sys.version_info[:2]

        # previous(): env-mode record .image.before-<tag> (docker inspect stubbed)
        with io.open(os.path.join(compose_dir, ".image.before-auto-2"), "w", encoding="utf-8") as f:
            f.write("local/chisabot:latest\n")
        m.run = lambda args, timeout=60, env=None: (0, "")
        prev = u.previous({"image": "local/chisabot:auto-2"})
        assert prev == {"image": "local/chisabot:latest"}, prev
        assert u.previous({"image": "local/chisabot:nope"}) is None

        # magpie: a fourth action, handled like update/rollback (Popen stubbed, nothing runs)
        assert "magpie" in m.ACTIONS, m.ACTIONS
        assert m.VERSION == "4", m.VERSION
        with io.open(os.path.join(home, "magpie.sh"), "w", encoding="utf-8") as f:
            f.write("#!/bin/bash\nexit 0\n")
        started = []

        class FakeChild(object):
            pass

        def fake_popen(args, **kwargs):
            started.append(args)
            stream = kwargs.get("stdout")
            if stream is not None:
                stream.close()
            return FakeChild()

        m.subprocess.Popen = fake_popen
        u.internal["job"] = None
        u.handle({"id": "magpie-test12345", "action": "magpie", "actor": "管理员"})
        assert started and started[0][1].endswith("magpie.sh"), started
        assert "--update" in started[0] and "--job" in started[0], started
        assert u.internal["job"]["action"] == "magpie", u.internal["job"]
        assert u.internal["job"]["status"] == "running", u.internal["job"]
        u.internal["job"]["status"] = "succeeded"
        print("chisabot-updater self-test OK on python %d.%d" % sys.version_info[:2])
    finally:
        shutil.rmtree(home, ignore_errors=True)


if __name__ == "__main__":
    main()
