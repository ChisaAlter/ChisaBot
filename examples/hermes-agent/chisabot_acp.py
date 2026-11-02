"""Run the existing server Hermes installation with ChisaBot-owned tools.

Launch with the existing Hermes venv Python and HERMES_SOURCE_DIR pointing to
its source checkout. Importing this file is stdlib-only; --check imports the
server installation and verifies the upstream API without creating an agent.
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import contextvars
import inspect
import json
import logging
import os
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace
from typing import Any

from chisabot_protocol import (GatewayClient, HostPrompt, ProtocolError, RunState, ToolAliases,
                                 TURN_FAILED, _ACTION_NUDGE, action_promise, active_run,
                                 failure_category, failure_message, fallback_reason, fallback_use,
                                 host_metadata, normalize_content, normalize_history,
                                 parse_host_prompt, redact, reply_failure_category, tool_error,
                                 turn_failure)

logger = logging.getLogger("chisabot_acp")


def _now() -> float:
    return time.monotonic()


def _env_float(name: str, default: float | None) -> float | None:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value >= 0 else default


def _env_int(name: str, default: int) -> int:
    value = _env_float(name, float(default))
    return int(value) if value is not None else default


"""Model breaker (QA1102-06): when a model keeps failing -- unavailable / timeout / 5xx / quota --
every turn must not pay the full upstream model-call timeout before Hermes walks its fallback
chain (production: codex/gpt-6-luna dead, ~113s of dead time per turn, 13 turns in 60 minutes;
the chain the adapter rebuilds each prompt always starts from the primary again, so nothing
upstream ever skips it). One process serves every session, so the breaker is module-level:
a cooled model is skipped for all actors/bots at once. After the cooldown one turn probes the
primary (half-open); a healthy answer closes it, another failure reopens it with an
exponentially longer cooldown. Tunables: CHISABOT_MODEL_BREAKER_THRESHOLD (consecutive
failures before opening, default 1), CHISABOT_MODEL_BREAKER_COOLDOWN_S (base, default 60),
CHISABOT_MODEL_BREAKER_MAX_COOLDOWN_S (cap, default 600)."""
_MODEL_BREAKERS: dict[tuple[str, str, str], dict[str, Any]] = {}
# Failure categories that mean "this model is not usable right now" -- key/auth, context
# length, content filter and plain unknowns are not the model being down.
_BREAKER_CATEGORIES = frozenset({"rate_limit", "quota", "timeout", "provider_unavailable", "model_not_found"})
_QUOTA_CATEGORIES = frozenset({"rate_limit", "quota"})
# A probe turn that never reports an outcome (cancelled, gateway death) must not gate the
# primary forever; this long without a verdict the probe is forgotten and retried.
_PROBE_STALE_S = 300.0


def _breaker_threshold() -> int:
    return max(1, _env_int("CHISABOT_MODEL_BREAKER_THRESHOLD", 1))


def _breaker_base_s() -> float:
    value = _env_float("CHISABOT_MODEL_BREAKER_COOLDOWN_S", 60.0)
    return value if value is not None and value > 0 else 60.0


def _breaker_max_s() -> float:
    value = _env_float("CHISABOT_MODEL_BREAKER_MAX_COOLDOWN_S", 600.0)
    return value if value is not None and value > 0 else 600.0


def _breaker_key(agent: Any, model_id: Any) -> tuple[str, str, str]:
    # The same model id on a different provider route is a different endpoint: keep them apart.
    return (str(getattr(agent, "provider", "") or ""), str(getattr(agent, "base_url", "") or ""), str(model_id))


def _breaker_log(line: dict[str, Any]) -> None:
    try:
        logger.info(json.dumps(line, ensure_ascii=False))
    except Exception:
        pass


def breaker_cooling(key: tuple[str, str, str], now: float) -> dict[str, Any] | None:
    """The open breaker entry while it still gates, else None (a stale probe stops gating)."""
    entry = _MODEL_BREAKERS.get(key)
    if entry is None:
        return None
    if entry.get("probing"):
        if now - float(entry.get("probe_started", now)) < _PROBE_STALE_S:
            return entry
        entry["probing"] = False
        _breaker_log({"type": "model-fallback", "event": "breaker-probe-stale", "model": key[2], "kernel": "hermes-adapter"})
    return entry if entry["open_until"] > now else None


def breaker_fail(key: tuple[str, str, str], reason: str, now: float) -> None:
    entry = _MODEL_BREAKERS.setdefault(key, {"failures": 0, "opens": 0, "reason": reason,
                                             "open_until": 0.0, "probing": False})
    entry["failures"] += 1
    entry["reason"] = reason
    entry["probing"] = False
    if entry["failures"] < _breaker_threshold() or entry["open_until"] > now:
        return
    cooldown = min(_breaker_base_s() * (2 ** entry["opens"]), _breaker_max_s())
    entry["open_until"] = now + cooldown
    entry["opens"] += 1
    _breaker_log({"type": "model-fallback", "event": "breaker-open", "model": key[2], "reason": reason,
                  "consecutiveFailures": entry["failures"], "cooldownSeconds": round(cooldown),
                  "kernel": "hermes-adapter"})


def breaker_ok(key: tuple[str, str, str]) -> None:
    entry = _MODEL_BREAKERS.pop(key, None)
    if entry is not None and entry.get("opens"):
        _breaker_log({"type": "model-fallback", "event": "breaker-closed", "model": key[2], "kernel": "hermes-adapter"})


def breaker_count(key: tuple[str, str, str], reason: str, now: float) -> None:
    """One consecutive failure without opening a cooldown (error mid-stream after output)."""
    entry = _MODEL_BREAKERS.setdefault(key, {"failures": 0, "opens": 0, "reason": reason,
                                             "open_until": 0.0, "probing": False})
    entry["failures"] += 1
    entry["reason"] = reason
    entry["probing"] = False
    _breaker_log({"type": "model-fallback", "event": "stream-error", "model": key[2], "reason": reason,
                  "consecutiveFailures": entry["failures"], "kernel": "hermes-adapter"})


def reset_model_breakers() -> None:
    _MODEL_BREAKERS.clear()


"""QA1102-14：主模型拒绝了请求本身（400 invalid input / 上下文超长）时的处理。
模型没病——是这份历史它不接收，所以：
1. 这一类的换模型不算模型故障（``fallback_reason`` 归 "rejected"），不进断路器 / 冷却；
2. 这一轮先「清洗 + 激进压缩」历史，用主模型重试一次；还不行才落到备用模型。
清洗规则见 chisabot_protocol.normalize_history；这里的「激进」是再按尾部保留限界。"""
_RETRY_ONCE_CATEGORIES = frozenset({"invalid_request", "context_length"})
_RETRY_KEEP_MESSAGES = 48
_RETRY_HISTORY_CHARS = 64_000


def _deep_clean_history(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """重试用的激进历史：先全量规范化，再从尾部保留最近 ~48 条 / ~64k 字符，再规范一次补配对。"""
    cleaned = normalize_history(list(messages))
    budget = _RETRY_HISTORY_CHARS
    kept: list[dict[str, Any]] = []
    for row in reversed(cleaned):
        kept.append(row)
        budget -= len(str(row.get("content") or "")) + 200
        if budget <= 0 or len(kept) >= _RETRY_KEEP_MESSAGES:
            break
    kept.reverse()
    return normalize_history(kept)


"""First-token deadline (QA1102-06): every model attempt -- the first failing one and each
half-open probe alike -- is bounded by how long it may produce no real output (text /
reasoning / tool delta). A hung upstream call is interrupted and the turn retries on the
next healthy fallback instead of paying the full CHISABOT_MODEL_TIMEOUT_S upstream timeout.
CHISABOT_FIRST_TOKEN_TIMEOUT_S sets the bound (default 30, 0 disables); the TS kernel's
CHISABOT_MODEL_FIRST_OUTPUT_MS is honoured when set."""
def _first_token_timeout_s() -> float:
    value = _env_float("CHISABOT_FIRST_TOKEN_TIMEOUT_S", None)
    if value is not None:
        return value
    ms = _env_float("CHISABOT_MODEL_FIRST_OUTPUT_MS", None)
    return ms / 1000.0 if ms is not None else 30.0


def _discard_attempt(future) -> None:
    """Retrieve an abandoned attempt's outcome so it never warns "exception was never
    retrieved"; the result itself is thrown away — the turn already moved to a fallback."""
    try:
        future.exception()
    except Exception:
        pass


def _interrupt_until_done(interrupt, agent: Any, future, *, tries: int = 40,
                          interval: float = 0.25) -> None:
    """Keep nudging an abandoned call's interrupt until it exits (bounded, daemon).

    The one-shot interrupt can be lost: a call that had not entered its interruptible
    section yet clears the flag on entry and then ignores the one that already fired.
    It runs on a daemon thread so nothing — including an executor shutdown — joins it.
    """
    for _ in range(tries):
        if future.done():
            return
        time.sleep(interval)
        try:
            interrupt(agent)
        except Exception:
            return


def _wait_first_output(event: threading.Event, deadline: float,
                       reset: threading.Event | None = None) -> bool:
    """True when real output arrived before the deadline; polls so a stale wait ends quickly.

    ``reset`` ends the wait early with False: the 400 cleanup retry inside execute() is a
    fresh attempt that re-arms the deadline instead of spending the rejected call's window.
    """
    end = time.monotonic() + deadline
    while True:
        if reset is not None and reset.is_set():
            return False
        remaining = end - time.monotonic()
        if remaining <= 0:
            return False
        if event.wait(min(0.05, remaining)):
            return True


"""Bounds for the upstream model call itself. Hermes 110s-per-turn came from its own call
timeout plus retries; these env overrides are applied only to knobs the installed Hermes
really exposes (detected in its AIAgent signature / attributes, never assumed):
CHISABOT_MODEL_TIMEOUT_S (default 90), CHISABOT_MODEL_CONNECT_TIMEOUT_S (default 15),
CHISABOT_MODEL_MAX_RETRIES (default 1)."""
_LIMIT_PARAMS = {
    "timeout": ("timeout", "request_timeout", "read_timeout", "model_timeout", "llm_timeout", "call_timeout"),
    "connect_timeout": ("connect_timeout",),
    "max_retries": ("max_retries", "retries", "retry_count", "max_retry_count"),
}


def _call_limits() -> dict[str, float | int]:
    timeout = _env_float("CHISABOT_MODEL_TIMEOUT_S", 90.0)
    connect = _env_float("CHISABOT_MODEL_CONNECT_TIMEOUT_S", 15.0)
    return {"timeout": timeout if timeout is not None else 90.0,
            "connect_timeout": connect if connect is not None else 15.0,
            "max_retries": _env_int("CHISABOT_MODEL_MAX_RETRIES", 1)}


def apply_call_limits(agent: Any) -> None:
    """Set the configured limits on attributes the installed Hermes really has."""
    limits = _call_limits()
    for limit, names in _LIMIT_PARAMS.items():
        for name in names:
            try:
                present = hasattr(agent, name)
            except Exception:
                present = False
            if not present:
                continue
            try:
                setattr(agent, name, limits[limit])
            except Exception:
                pass
            break


def pick_turn_model(agent: Any, config: HostPrompt, now: float | None = None) -> list[tuple[str, str | None]]:
    """Ordered (model_id, cooled_reason) to try this turn.

    Primary first while its breaker is closed; while it gates, every healthy configured
    fallback (in order) then the primary as the last resort -- a turn with no healthy
    candidate still tries the primary rather than failing outright. The first entry is the
    one applied; ``cooled_reason`` is non-None for models used in place of a cooled primary.
    An expired breaker arms one half-open probe: the primary runs again, and while that turn
    is in flight other sessions keep skipping it.
    """
    now = _now() if now is None else now
    key = _breaker_key(agent, config.model_id)
    entry = _MODEL_BREAKERS.get(key)
    cooling = breaker_cooling(key, now)
    if cooling is None:
        if entry is not None and not entry.get("probing"):
            entry["probing"] = True
            entry["probe_started"] = now
            _breaker_log({"type": "model-fallback", "event": "breaker-probe", "model": config.model_id,
                          "kernel": "hermes-adapter"})
        return [(config.model_id, None)]
    remaining = max(0.0, cooling["open_until"] - now)
    candidates = [model for model in config.fallbacks
                  if breaker_cooling(_breaker_key(agent, model), now) is None]
    if not candidates:
        return [(config.model_id, None)]
    _breaker_log({"type": "model-fallback", "event": "skip-primary", "model": config.model_id,
                  "fallback": candidates[0], "reason": cooling["reason"],
                  "cooldownRemainingSeconds": round(remaining), "kernel": "hermes-adapter"})
    return [(model, cooling["reason"]) for model in candidates] + [(config.model_id, None)]


def model_controls() -> dict[str, bool]:
    """Which per-turn model controls the installed Hermes really has (detected, never assumed).

    fallback: AIAgent accepts ``fallback_model``, has the per-turn ``_try_activate_fallback`` switch and
    ``agent.agent_init_fallback._init_fallback_chain`` exists. maxOutputTokens: AIAgent accepts
    ``max_tokens`` (every request reads ``agent.max_tokens``). The host shows "不生效" only from this.
    """
    try:
        from run_agent import AIAgent
        parameters = inspect.signature(AIAgent.__init__).parameters
    except Exception:
        return {"fallback": False, "maxOutputTokens": False}
    fallback = "fallback_model" in parameters and callable(getattr(AIAgent, "_try_activate_fallback", None))
    if fallback:
        try:
            from agent.agent_init_fallback import _init_fallback_chain
            fallback = callable(_init_fallback_chain)
        except Exception:
            fallback = False
    return {"fallback": bool(fallback), "maxOutputTokens": "max_tokens" in parameters}


def install_fallback_probe(agent: Any) -> None:
    """Record each successful Hermes model switch for the current turn (ids and reason only)."""
    if getattr(agent, "_chisabot_fallback_probe", None) is not None:
        return
    original = agent._try_activate_fallback

    def probe(*args, **kwargs):
        switched = original(*args, **kwargs)
        if switched:
            uses = getattr(agent, "_chisabot_fallback_uses", None)
            if isinstance(uses, list):
                uses.append((getattr(agent, "model", None), kwargs.get("reason", args[0] if args else None)))
        return switched

    agent._try_activate_fallback = probe
    agent._chisabot_fallback_probe = probe


def apply_model_controls(agent: Any, config: HostPrompt, controls: dict[str, bool],
                         applied: str | None = None) -> None:
    """Apply the host's backup models and output cap to this turn. Unsupported controls are skipped."""
    if hasattr(agent, "compression_enabled"):
        # Hermes' ``compression.enabled`` gate covers every automatic trigger (preflight, mid-turn,
        # overflow recovery). Off only for runs the host already compacted; otherwise the agent default.
        if not hasattr(agent, "_chisabot_default_compression"):
            agent._chisabot_default_compression = agent.compression_enabled
        agent.compression_enabled = (False if config.context_compression is False
                                     else agent._chisabot_default_compression)
    if controls.get("maxOutputTokens"):
        if not hasattr(agent, "_chisabot_default_max_tokens"):
            agent._chisabot_default_max_tokens = getattr(agent, "max_tokens", None)
        agent.max_tokens = config.max_output_tokens or agent._chisabot_default_max_tokens
    if controls.get("fallback"):
        from agent.agent_init_fallback import _init_fallback_chain
        base_url = getattr(agent, "base_url", None)
        now = _now()
        current = applied or config.model_id
        # Same connection as the primary model: same provider route and endpoint, only the model
        # differs. The model this turn already runs on and models whose breaker is open stay out
        # of the chain: a mid-turn failure must not walk back into a dead model.
        chain = [{"provider": agent.provider, "model": model, **({"base_url": base_url} if base_url else {})}
                 for model in config.fallbacks
                 if model != current and breaker_cooling(_breaker_key(agent, model), now) is None]
        try:
            _init_fallback_chain(agent, chain)
            install_fallback_probe(agent)
        except Exception:
            logger.warning("Hermes rejected the host backup model chain; this turn runs without backups")


def configure_source(source_dir: str | None = None) -> Path:
    """Pin source before *any* Hermes import, including hermes_bootstrap."""
    os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
    raw = source_dir or os.environ.get("HERMES_SOURCE_DIR")
    if not raw:
        raise ProtocolError("HERMES_SOURCE_DIR must point to the existing Hermes checkout")
    source = Path(raw).expanduser().resolve()
    if not (source / "acp_adapter" / "server.py").is_file() or not (source / "run_agent.py").is_file():
        raise ProtocolError("HERMES_SOURCE_DIR does not contain the required Hermes source files")
    source_path = str(source)
    sys.path[:] = [source_path] + [entry for entry in sys.path if entry != source_path]
    import hermes_bootstrap
    harden = getattr(hermes_bootstrap, "harden_import_path", None)
    if harden:
        harden()
    # Some bootstrap versions remove launch-cwd paths: re-pin the trusted source.
    sys.path[:] = [source_path] + [entry for entry in sys.path if entry != source_path]
    return source


def build_agent_class():
    """Load Hermes lazily so all local tests can use explicit fake modules."""
    import acp
    from acp.schema import NewSessionResponse, PromptResponse, ToolCallProgress, ToolCallStart
    from acp_adapter.content import _content_blocks_to_openai_user_content, _extract_text
    from acp_adapter.events import AssistantMessageIdAllocator, make_message_cb, make_thinking_cb
    from acp_adapter.server import HermesACPAgent
    from acp_adapter.session import SessionManager
    from agent.interrupt_compat import request_hard_interrupt
    from agent.inline_tool_executors import INLINE_TOOL_EXECUTORS
    from model_tools import _AGENT_LOOP_TOOLS, _LEGACY_TOOL_ALIASES
    from tools.approval_context import _approval_tool_call_id
    from tools.registry import registry, session_tool_scope

    reserved = (set(INLINE_TOOL_EXECUTORS) | set(_AGENT_LOOP_TOOLS) | set(_LEGACY_TOOL_ALIASES)
                | {"delegate_task", "tool_call", "tool_search", "tool_describe", "manage_connections"})

    def invalid(message: str):
        return acp.RequestError.invalid_params({"details": message})

    def tool_aliases(config: HostPrompt) -> ToolAliases:
        return ToolAliases.for_prompt(config, reserved)

    def restrict(agent: Any) -> None:
        agent.enabled_toolsets, agent.disabled_toolsets = ["chisabot"], []
        agent.tools, agent.valid_tool_names = [], set()
        # No persisted Hermes tool pins or inline memory/context-engine tools.
        agent._persist_disabled = True
        agent._session_db = None
        agent._session_db_created = False
        agent._context_engine_tool_names = set()
        agent._memory_manager = None
        agent._tool_search_scope_cache = None

    class HostSessionManager(SessionManager):
        """Host history is authoritative; no transcript or capability is stored in Hermes DB."""

        def _get_db(self):
            return None

        def _persist(self, state):
            return None

        def _make_agent(self, *, session_id, cwd, model=None, requested_provider=None,
                        base_url=None, api_mode=None, enabled_toolsets=None, disabled_toolsets=None):
            # Build directly to skip SessionManager's configured MCP discovery, native
            # memory and workspace imports. Model switching still uses the native
            # resolver and calls this factory with keep_endpoint's base_url/api_mode.
            from run_agent import AIAgent
            from hermes_cli.config import get_compatible_custom_providers, load_config
            from hermes_cli.runtime_provider import resolve_runtime_provider
            from hermes_constants import resolve_reasoning_config

            config = load_config()
            model_config = config.get("model")
            default_model = (str(model_config.get("default") or "") if isinstance(model_config, dict)
                             else str(model_config or ""))
            provider = model_config.get("provider") if isinstance(model_config, dict) else None
            selected_model = model or default_model
            wanted = requested_provider or provider
            if wanted == "custom" and base_url:
                # _switch_model echoes the resolved provider *type* ("custom") when the session
                # stays on a named custom provider's endpoint, but the runtime resolver only
                # accepts real provider names. Recover the name from the carried endpoint.
                kept = str(base_url).strip().rstrip("/").lower()
                for entry in get_compatible_custom_providers(config):
                    if str(entry.get("base_url") or "").strip().rstrip("/").lower() == kept:
                        wanted = str(entry.get("name") or "").strip() or wanted
                        break
            route = resolve_runtime_provider(requested=wanted, target_model=selected_model or None)
            kwargs = dict(model=selected_model, provider=route.get("provider"),
                          api_mode=api_mode or route.get("api_mode"), base_url=base_url or route.get("base_url"),
                          api_key=route.get("api_key"), credential_pool=route.get("credential_pool"),
                          command=route.get("command"), args=list(route.get("args") or []),
                          reasoning_config=resolve_reasoning_config(config, selected_model),
                          enabled_toolsets=[], disabled_toolsets=[], platform="acp", quiet_mode=True,
                          session_id=session_id, session_db=None, cwd=cwd, skip_context_files=True,
                          skip_memory=True, skip_background_review=True, load_soul_identity=False,
                          checkpoints_enabled=False, save_trajectories=False)
            if route.get("request_overrides") and (not base_url or base_url == route.get("base_url")):
                kwargs["request_overrides"] = route["request_overrides"]
            # Bound the model call only through knobs this Hermes really has (detected, never
            # assumed): named AIAgent kwargs first, request_overrides for the provider client.
            try:
                signature = inspect.signature(AIAgent.__init__).parameters
            except (TypeError, ValueError):
                signature = {}
            limits = _call_limits()
            for limit, names in _LIMIT_PARAMS.items():
                for name in names:
                    if name in signature:
                        kwargs.setdefault(name, limits[limit])
                        break
            if "request_overrides" in signature:
                overrides = dict(kwargs.get("request_overrides") or {})
                overrides.setdefault("timeout", limits["timeout"])
                overrides.setdefault("max_retries", limits["max_retries"])
                kwargs["request_overrides"] = overrides
            agent = AIAgent(**kwargs)
            restrict(agent)
            apply_call_limits(agent)
            agent._print_fn = lambda *a, **kw: print(*a, **{**kw, "file": sys.stderr})
            return agent

    class ChisaBotACPAgent(HermesACPAgent):
        # Upstream __new__(None) creates GatewayACPAgent; explicitly construct this subclass.
        def __new__(cls, session_manager=None, **kwargs):
            return object.__new__(cls)

        def __init__(self, session_manager=None, *, gateway_factory=GatewayClient):
            super().__init__(session_manager=session_manager if session_manager is not None else HostSessionManager())
            self._host_scopes: dict[str, tuple[str, str, str]] = {}
            self._host_tools: dict[str, set[str]] = {}
            self._host_models: dict[str, str] = {}
            self._host_locks: dict[str, asyncio.Lock] = {}
            self._host_runs: dict[str, RunState] = {}
            self._host_aliases: dict[str, ToolAliases] = {}
            self._gateway_factory = gateway_factory
            self._model_controls: dict[str, bool] | None = None

        def _controls(self) -> dict[str, bool]:
            if self._model_controls is None:
                self._model_controls = model_controls()
            return self._model_controls

        async def initialize(self, *args, **kwargs):
            response = await super().initialize(*args, **kwargs)
            response.field_meta = {**(response.field_meta or {}), "chisabotHostTools": 1,
                                   "chisabotModelControls": dict(self._controls())}
            capabilities = response.agent_capabilities
            capabilities.field_meta = {**(capabilities.field_meta or {}), "chisabotHostTools": 1}
            # This process is ephemeral; the bridge restores its own canonical history.
            capabilities.load_session = False
            capabilities.session_capabilities = None
            return response

        async def new_session(self, cwd: str, mcp_servers=None, **kwargs):
            if mcp_servers:
                raise invalid("ChisaBot host mode does not accept MCP servers")
            # session/new normally carries only chisabotNamespace. Full metadata is
            # optional here, mandatory on every session/prompt.
            raw = host_metadata(kwargs, required=False)
            try:
                config = parse_host_prompt(raw) if raw is not None else None
                if config:
                    tool_aliases(config)
            except ProtocolError as exc:
                raise invalid(str(exc)) from None
            state = await asyncio.to_thread(self.session_manager.create_session, cwd=cwd)
            restrict(state.agent)
            if config:
                try:
                    await self._configure(state, config)
                except ProtocolError as exc:
                    raise invalid(str(exc)) from None
            return NewSessionResponse(session_id=state.session_id,
                                      field_meta={"chisabotHostTools": 1})

        def _bind_live_agent(self, state, config: HostPrompt, *, applied=None, skip_reason=None,
                             cbs=None, gate=None):
            """把宿主的绑定重新落在切换后还活着的 agent 上。

            原生换模型路径 set_session_model → _switch_model → _make_agent 可能整个重建
            state.agent：切换前绑定在旧对象上的 restrict / 工具面 / 系统提示词 / 模型控制 /
            流式回调会全部丢掉（QA1102-13 r1：首 token 超时同轮换备用，那次 tools=[] 还没
            系统提示词）。任何一次模型切换之后都必须经过这里，先重新读一次 state.agent。
            """
            agent = state.agent
            if applied is not None:
                agent._chisabot_turn_model = applied
                agent._chisabot_breaker_skip = (applied, skip_reason) if applied != config.model_id else None
            restrict(agent)
            apply_call_limits(agent)
            apply_model_controls(agent, config, self._controls(), applied)
            installed = self._host_tools.get(state.session_id) or set()
            with session_tool_scope(state.session_id):
                agent.tools = registry.get_definitions(installed, quiet=True)
            agent.valid_tool_names = {t["function"]["name"] for t in agent.tools}
            if installed and agent.valid_tool_names != installed:
                raise ProtocolError("Hermes did not expose the complete host tool surface")
            aliases = self._host_aliases.get(state.session_id)
            if aliases is not None:
                agent.ephemeral_system_prompt = aliases.text(config.system_prompt)
                if callable(invalidate := getattr(agent, "_invalidate_system_prompt", None)):
                    invalidate()
            if cbs is not None and callable(getattr(cbs, "attach", None)):
                cbs.attach(agent, gate if gate is not None else getattr(cbs, "gate", None))
            return agent

        async def _configure(self, state, config: HostPrompt):
            session_id = state.session_id
            known_scope = self._host_scopes.get(session_id)
            if known_scope is not None and known_scope != config.scope.session_key:
                raise ProtocolError("ACP session scope does not match actorId, botId and threadId")
            aliases = tool_aliases(config)
            self._host_aliases[session_id] = aliases
            applied, skip_reason = config.model_id, None
            for model_id, cooled_reason in pick_turn_model(state.agent, config):
                agent = state.agent
                if self._host_models.get(session_id) != model_id or getattr(agent, "model", model_id) != model_id:
                    try:
                        # Native method validates unknown models and passes keep_endpoint=True
                        # to _switch_model: the configured server Magpie route survives.
                        response = await super().set_session_model(model_id=model_id, session_id=session_id)
                    except Exception:
                        response = None
                    if response is None:
                        if model_id != config.model_id:
                            # A fallback Hermes itself rejects is cooled like any broken model.
                            breaker_fail(_breaker_key(state.agent, model_id), "unavailable", _now())
                            continue
                        raise ProtocolError("The requested host model was rejected or could not be configured") from None
                    self._host_models[session_id] = model_id
                applied, skip_reason = model_id, cooled_reason
                break
            if applied is None:
                raise ProtocolError("The requested host model could not be configured")
            for name in self._host_tools.pop(session_id, set()):
                registry.deregister(name, scope=session_id)
            installed = set()
            try:
                with session_tool_scope(session_id):
                    for tool in config.tools:
                        def handler(args, _name=tool.name, **_kwargs):
                            run = active_run.get()
                            if run is None or run.session_id != session_id:
                                return tool_error("run_closed", "There is no active host-tool turn")
                            call_id = _approval_tool_call_id.get()
                            # This ContextVar is bound by model_tools._execute_tool.
                            # Never substitute an ACP synthetic ID or a handler kwarg.
                            return run.execute(call_id, _name, args)

                        internal_name = aliases.internal(tool.name)
                        schema = tool.registry_schema()
                        schema["name"] = internal_name
                        schema["description"] = aliases.text(schema["description"])
                        registry.register(name=internal_name, toolset="chisabot", schema=schema,
                                          handler=handler, scope=session_id, override=True)
                        installed.add(internal_name)
                        # register/snapshot normalize scope; upstream get_entry's
                        # explicit-scope path looks up the raw key instead.
                        entry = registry.snapshot_registration(internal_name, scope=session_id)
                        if entry is None or entry.handler is not handler or entry.toolset != "chisabot":
                            raise ProtocolError("Hermes rejected a scoped host tool registration")
            except Exception:
                for name in installed:
                    registry.deregister(name, scope=session_id)
                restrict(state.agent)
                raise ProtocolError("The scoped host tool surface could not be registered") from None
            self._host_tools[session_id] = installed
            self._host_scopes[session_id] = config.scope.session_key
            # QA1102-13：原生换模型路径可能重建 state.agent——restrict / 工具面 / 系统提示词 /
            # 模型控制 / 回调一律通过 _bind_live_agent 落在切换后的活 agent 上。
            agent = self._bind_live_agent(state, config, applied=applied, skip_reason=skip_reason)
            # QA1102-13 防御：宿主给了工具但活 agent 上没长出任何可调工具——显式失败，
            # 别让模型在没有 tools 数组的情况下静默跑完这一轮（4b323956 曾把配置写进被
            # 换模型重建丢弃的旧 agent，那一轮 tools=[] 还没系统提示词）。
            if config.tools and not getattr(state.agent, "valid_tool_names", None):
                raise ProtocolError("The configured host tools never reached the live agent")
            # QA1102-14：发给 OpenAI 兼容端点（DeepSeek 等）的历史先规范化——空 content、
            # 不支持的块、孤儿 tool 消息、没有结果的 tool_calls、超长 tool 输出都会被端点
            # 整单 400 拒掉（messages.N.content）。
            state.history = aliases.history(normalize_history(config.history, images=config.model_images,
                                                              files=config.model_files))
            state.queued_prompts.clear()
            state.interrupted_prompt_text = ""

        @staticmethod
        def _send_tool(conn, session_id, loop, update):
            if conn is None:
                raise RuntimeError("A connected ACP client is required for host tools")
            future = asyncio.run_coroutine_threadsafe(conn.session_update(session_id, update), loop)
            try:
                future.result(timeout=10)
            except Exception:
                future.cancel()
                raise RuntimeError("ACP tool update failed") from None

        def _wire_turn_callbacks(self, state, session_id, conn, loop, first_output=None):
            run = active_run.get()
            if run is None:
                raise RuntimeError("A host run is required")
            cbs = SimpleNamespace(streamed=False, approval_cb=None, edit_approval_requester=None)
            aliases = self._host_aliases[session_id]
            if state.message_ids is None:
                state.message_ids = AssistantMessageIdAllocator()
            state.message_ids.close()
            text_cb = make_message_cb(conn, session_id, loop, state.message_ids) if conn else None
            thought_cb = make_thinking_cb(conn, session_id, loop, state.message_ids) if conn else None

            def attach(agent, gate):
                """Pin this turn's callbacks on the agent — again after a switch rebuilt it."""
                if gate is None:
                    gate = SimpleNamespace(event=threading.Event(), live=True, overall=None)

                def produced():
                    # Any text/reasoning/tool callback is real model output: it satisfies the
                    # first-token deadline (stream-start / metadata frames never reach here).
                    if gate.live:
                        gate.event.set()
                        if gate.overall is not None:
                            gate.overall.set()

                def stream(text):
                    if not (gate.live and run.may_stream() and text_cb):
                        return
                    if reply_failure_category(text) is not None:
                        # Hermes narrates a failed model call as reply text ("custom
                        # rejected your API key … Provider said: HTTP 401: …"): the
                        # classified turn error carries it, not an assistant bubble.
                        return
                    produced()
                    safe = redact(text, run.config.gateway.capability)
                    cbs.streamed = cbs.streamed or bool(safe)
                    text_cb(safe)

                def reasoning(text):
                    produced()
                    if gate.live and run.may_stream() and thought_cb:
                        thought_cb(redact(text, run.config.gateway.capability))

                def start(call_id, name, args):
                    produced()
                    name = aliases.canonical(name)
                    safe_args = redact(copy.deepcopy(args), run.config.gateway.capability)
                    update = ToolCallStart(session_update="tool_call", tool_call_id=call_id,
                                           title=name, kind="other", status="in_progress", raw_input=safe_args,
                                           field_meta={"name": name, "chisabot": {"version": 1, "callId": call_id, "name": name,
                                                                                   "inputComplete": True}})
                    run.start(call_id, name, args,
                              lambda: self._send_tool(conn, session_id, loop, update))

                def complete(call_id, name, args, result):
                    self._complete_tool(run, conn, loop, call_id, aliases.canonical(name), result)

                # Default progress/step callbacks manufacture IDs; retain only text/reasoning.
                agent.tool_progress_callback = None
                agent.step_callback = None
                agent.thinking_callback = None
                agent.reasoning_callback, agent.stream_delta_callback = reasoning, stream
                agent.tool_start_callback, agent.tool_complete_callback = start, complete

            gate = SimpleNamespace(event=first_output or threading.Event(), live=True,
                                   overall=first_output)
            cbs.gate = gate
            cbs.attach = attach
            attach(state.agent, gate)
            return cbs

        def _complete_tool(self, run, conn, loop, call_id, name, result, *, abandoned=False):
            with run.lock:
                record = run.records.get(call_id)
                if not record or record.completed or run.closed:
                    return
                waiting = run.pending_suspension
                is_waiting = bool(waiting and waiting["callId"] == call_id)
                metadata = {"version": 1, "callId": call_id, "name": name}
                if is_waiting:
                    metadata["waiting"] = copy.deepcopy(waiting["waiting"])
                safe_result = redact(result, run.config.gateway.capability)
                if not isinstance(safe_result, str):
                    import json
                    safe_result = json.dumps(safe_result, ensure_ascii=False)
                failed = abandoned
                try:
                    import json
                    value = json.loads(safe_result)
                    failed = failed or (isinstance(value, dict) and (value.get("ok") is False or bool(value.get("error"))))
                except (ValueError, TypeError):
                    pass
                update = ToolCallProgress(session_update="tool_call_update", tool_call_id=call_id,
                                          status="pending" if is_waiting else ("failed" if failed else "completed"),
                                          raw_output=None if is_waiting else safe_result,
                                          content=None if is_waiting else [acp.tool_content(acp.text_block(safe_result))],
                                          field_meta={"name": name, "chisabot": metadata})
                record.completed = True
            try:
                self._send_tool(conn, run.session_id, loop, update)
            except Exception:
                run.fail("ACP tool result could not be delivered")

        def _observe_turn(self, state, config: HostPrompt, uses, *, finished: bool, failure: str | None,
                          had_output: bool = False) -> None:
            """Feed this turn's model outcome into the breaker (QA1102-06).

            Each recorded Hermes switch means the model before it failed: the turn's applied
            model for the first switch, the previous switch's target for later ones. The model
            the turn ended on is marked healthy only when the turn actually finished answering.
            """
            try:
                agent = state.agent
                now = _now()
                applied = getattr(agent, "_chisabot_turn_model", None) or config.model_id
                previous = applied
                for target, reason in uses:
                    # QA1102-14：「请求被主模型拒绝」（400 / 上下文超长）不是模型故障，
                    # 不能开断路器——否则每一轮都跳过主模型、全落在小备用模型上。
                    why = fallback_reason(reason)
                    if why != "rejected":
                        breaker_fail(_breaker_key(agent, previous), why, now)
                    if target:
                        previous = str(target)
                # The live model at turn end is the last one tried (a Hermes without the
                # fallback probe may have switched without a recorded use).
                previous = str(getattr(agent, "model", None) or previous)
                key = _breaker_key(agent, previous)
                if failure is not None:
                    if failure in _BREAKER_CATEGORIES:
                        reason = "quota" if failure in _QUOTA_CATEGORIES else "unavailable"
                        if had_output:
                            # The model already answered before dying mid-stream: one
                            # consecutive failure, no cooldown, and the error still propagates.
                            breaker_count(key, reason, now)
                        else:
                            breaker_fail(key, reason, now)
                    elif (entry := _MODEL_BREAKERS.get(key)) is not None:
                        # Any terminal outcome releases the half-open probe for the next turn.
                        entry["probing"] = False
                elif finished:
                    breaker_ok(key)
            except Exception:
                pass

        def _prime_rejected_retry(self, state, config: HostPrompt, cbs=None) -> None:
            """QA1102-14：回到主模型、清掉这一轮里 Hermes 记的换模型记录、换上激进压缩后的历史。"""
            applied = getattr(state.agent, "_chisabot_turn_model", None) or config.model_id
            # 同一条 _bind_live_agent 路径：就算这次重试前 agent 又被重建过，
            # 绑定也照样落在活对象上。
            agent = self._bind_live_agent(state, config, applied=applied, cbs=cbs,
                                          gate=getattr(cbs, "gate", None))
            agent.model = applied
            agent._fallback_index = 0
            agent._chisabot_fallback_uses = []
            agent._chisabot_breaker_skip = None
            state.history = _deep_clean_history(state.history)
            _breaker_log({"type": "model-fallback", "event": "rejected-retry", "model": applied,
                          "kernel": "hermes-adapter"})

        async def _retry_turn_model(self, state, config: HostPrompt, tried: set[str], *,
                                    cbs=None, gate=None) -> bool:
            """Switch the session to the next healthy model after a first-token timeout.

            The just-failed model's breaker is already open, so pick_turn_model orders the
            configured fallbacks first; models this turn already tried are skipped so a turn
            with no healthy candidate ends instead of dialling a dead model again.
            """
            for model_id, cooled_reason in pick_turn_model(state.agent, config):
                if model_id in tried:
                    continue
                previous = state.agent
                try:
                    response = await super().set_session_model(model_id=model_id, session_id=state.session_id)
                except Exception:
                    response = None
                if response is None:
                    tried.add(model_id)
                    if model_id != config.model_id:
                        breaker_fail(_breaker_key(state.agent, model_id), "unavailable", _now())
                    continue
                self._host_models[state.session_id] = model_id
                uses = getattr(previous, "_chisabot_fallback_uses", None)
                # set_session_model may rebuild state.agent wholesale: re-pin the host's
                # restrict/tools/system-prompt/controls and this turn's callbacks on the
                # live object, not on the one the switch discarded (QA1102-13 r1).
                agent = self._bind_live_agent(state, config, applied=model_id,
                                              skip_reason=cooled_reason, cbs=cbs, gate=gate)
                if isinstance(uses, list) and getattr(agent, "_chisabot_fallback_uses", None) is None:
                    agent._chisabot_fallback_uses = uses
                return True
            return False

        async def _bounded_turn(self, state, config: HostPrompt, execute, cbs,
                                attempt_reset: threading.Event):
            """Run one turn; every model attempt is bounded by the first-token deadline.

            An attempt that produces no text/reasoning/tool output within
            CHISABOT_FIRST_TOKEN_TIMEOUT_S (default 30, 0 disables) is interrupted,
            counted as a breaker failure, and the turn retries on the next healthy
            fallback. Once real output arrives the attempt runs unbounded. A request the
            endpoint rejects (400 / context too long) is retried once on the same model with
            cleaned history inside ``execute``: the rejection is a response, not a hang, so
            that retry re-arms its own deadline window and never reaches the breaker.
            """
            loop = asyncio.get_running_loop()
            deadline = _first_token_timeout_s()
            tried: set[str] = set()
            gate = cbs.gate
            while True:
                applied = str(getattr(state.agent, "_chisabot_turn_model", None) or config.model_id)
                tried.add(applied)
                abandoned = threading.Event()
                # A fresh Context per attempt: an abandoned call still holds its own — the same
                # Context object cannot be re-entered while a previous attempt runs inside it.
                future = loop.run_in_executor(None, contextvars.copy_context().run,
                                              execute, abandoned)
                if deadline <= 0:
                    return await future
                while True:
                    waiter = asyncio.ensure_future(asyncio.to_thread(_wait_first_output, gate.event,
                                                                     deadline, attempt_reset))
                    done, _pending = await asyncio.wait({future, waiter},
                                                        return_when=asyncio.FIRST_COMPLETED)
                    if future in done:
                        gate.event.set()  # Release the waiter thread promptly.
                        return future.result()
                    if waiter.result():
                        return await future
                    if attempt_reset.is_set():
                        # execute() started its one cleanup retry: a fresh attempt on the
                        # same model gets a fresh deadline window.
                        attempt_reset.clear()
                        continue
                    break
                # Hung upstream: interrupt the call, count a breaker failure, retry on a fallback
                # WITHOUT joining the attempt. An upstream that ignores request_hard_interrupt
                # (a blocking read) may take the whole call timeout to return; the turn must not
                # wait it out (deadline 300ms measured 2005ms). The abandoned attempt finishes in
                # the background: its callbacks die on this dead gate, its result is discarded,
                # and it must not touch state via the cleanup retry or the promise nudge.
                gate.live = False
                abandoned.set()
                attempt_agent = state.agent
                try:
                    request_hard_interrupt(attempt_agent)
                except Exception:
                    pass
                future.add_done_callback(_discard_attempt)
                # The single interrupt above can race the call's own entry reset; keep
                # re-firing on a bounded daemon thread until the hung call exits.
                threading.Thread(target=_interrupt_until_done,
                                 args=(request_hard_interrupt, attempt_agent, future),
                                 daemon=True).start()
                breaker_fail(_breaker_key(state.agent, applied), "unavailable", _now())
                _breaker_log({"type": "model-fallback", "event": "primary-timeout", "model": applied,
                              "timeoutSeconds": round(deadline), "kernel": "hermes-adapter"})
                # The next attempt answers to a fresh gate; late output from the abandoned
                # call stays on the old one and can never satisfy the new deadline.
                gate = SimpleNamespace(event=threading.Event(), live=True, overall=gate.overall)
                cbs.gate = gate
                if not await self._retry_turn_model(state, config, tried, cbs=cbs, gate=gate):
                    raise acp.RequestError(-32603, failure_message("timeout"))
                if state.cancel_event:
                    state.cancel_event.clear()
                attempt_reset.clear()

        def _run_agent_turn(self, **kwargs):
            run = active_run.get()
            if run is None:
                raise RuntimeError("A host run is required")
            with session_tool_scope(run.session_id):
                return super()._run_agent_turn(**kwargs)

        async def prompt(self, prompt, session_id: str, **kwargs):
            try:
                config = parse_host_prompt(host_metadata(kwargs))
                tool_aliases(config)
            except ProtocolError as exc:
                raise invalid(str(exc)) from None
            state = await asyncio.to_thread(self.session_manager.get_session, session_id)
            if state is None:
                raise invalid("The requested ACP session does not exist")
            lock = self._host_locks.setdefault(session_id, asyncio.Lock())
            if lock.locked():
                raise invalid("The host session is busy; wait for the previous prompt response")
            async with lock:
                with state.runtime_lock:
                    if state.is_running or state.command_op:
                        raise invalid("The host session is busy")
                try:
                    await self._configure(state, config)
                except ProtocolError as exc:
                    raise invalid(str(exc)) from None
                user_content = (normalize_content(copy.deepcopy(config.current_message["content"]),
                                                  images=config.model_images, files=config.model_files)
                                if config.current_message is not None
                                else _content_blocks_to_openai_user_content(prompt))
                user_text = _extract_text(prompt).strip()
                if config.gateway.capability in str(user_content) or config.gateway.capability in user_text:
                    raise invalid("The gateway capability must not occur in the current prompt")
                if not user_text and not user_content:
                    raise invalid("The current user prompt must not be empty")
                conn, loop = self._conn, asyncio.get_running_loop()
                run = RunState(session_id, config, lambda: request_hard_interrupt(state.agent),
                               self._gateway_factory(config.gateway))
                token = active_run.set(run)
                if state.cancel_event:
                    state.cancel_event.clear()
                with state.runtime_lock:
                    state.is_running = True
                    state.current_prompt_text = user_text or "[User content]"
                self._host_runs[session_id] = run
                state.agent._chisabot_fallback_uses = []

                def execute(abandoned):
                    attempts = 0
                    nudged = False
                    step_text, step_content = user_text, user_content
                    while not abandoned.is_set():
                        try:
                            try:
                                result = self._run_agent_turn(state=state, session_id=session_id, user_text=step_text,
                                                              user_content=step_content, conn=conn, loop=loop,
                                                              approval_cb=None, edit_approval_requester=None)
                            except Exception as error:
                                # QA1102-14：请求本身被主模型拒了（400 / 上下文超长）——清洗 + 激进
                                # 压缩历史后用主模型重试一次；再不行才落到备用 / 报错，且只重试这一次。
                                if (not abandoned.is_set() and attempts == 0 and run.may_stream()
                                        and failure_category(error=error) in _RETRY_ONCE_CATEGORIES):
                                    attempts += 1
                                    # 拒单是作答不是挂起：重试作为新一次尝试领新的首字窗口。
                                    attempt_reset.set()
                                    self._prime_rejected_retry(state, config, cbs)
                                    continue
                                raise
                            if (not abandoned.is_set() and attempts == 0 and run.may_stream()
                                    and turn_failure(result) in _RETRY_ONCE_CATEGORIES):
                                attempts += 1
                                attempt_reset.set()
                                self._prime_rejected_retry(state, config, cbs)
                                continue
                            # QA1102-13：这轮一个工具都没调、回复却在承诺「先去查/先做」——
                            # 催它现在就调，只多走一步，之后无论说什么都收尾。
                            if (not abandoned.is_set() and not nudged and config.tools and not run.records and run.may_stream()
                                    and not run.pending_suspension and not result.get("interrupted")
                                    and turn_failure(result) is None
                                    and action_promise(result.get("final_response"))):
                                nudged = True
                                step_text = step_content = _ACTION_NUDGE
                                _breaker_log({"type": "promise-guard", "event": "nudge",
                                              "kernel": "hermes-adapter"})
                                continue
                            return result
                        finally:
                            with run.lock:
                                open_calls = [(call_id, rec.name) for call_id, rec in run.records.items() if not rec.completed]
                            for call_id, name in open_calls:
                                self._complete_tool(run, conn, loop, call_id, name,
                                                    tool_error("tool_interrupted", "The host tool ended without a result"),
                                                    abandoned=True)

                try:
                    first_output = threading.Event()
                    attempt_reset = threading.Event()
                    cbs = self._wire_turn_callbacks(state, session_id, conn, loop, first_output)
                    result = await self._bounded_turn(state, config, execute, cbs,
                                                      attempt_reset)
                    if run.fatal_error:
                        raise acp.RequestError(-32603, run.fatal_error)
                    if not isinstance(result, dict):
                        raise acp.RequestError(-32603, "Hermes returned an invalid host turn result")
                    uses = list(getattr(state.agent, "_chisabot_fallback_uses", None) or [])
                    failed_category = turn_failure(result)
                    self._observe_turn(state, config, uses,
                                       finished=failed_category is None and not result.get("interrupted"),
                                       failure=failed_category, had_output=first_output.is_set())
                    history = result.get("messages")
                    if isinstance(history, list):
                        history = copy.deepcopy(history)
                        if config.continuation:
                            # The synthetic continue instruction is an execution hint. The
                            # real tool result already exists in canonical host history.
                            index = result.get("current_turn_user_idx")
                            if (isinstance(index, int) and 0 <= index < len(history)
                                    and history[index].get("role") == "user"):
                                history.pop(index)
                            else:
                                for index in range(len(config.history), len(history)):
                                    row = history[index]
                                    if row.get("role") == "user" and row.get("content") == user_content:
                                        history.pop(index)
                                        break
                        state.history = redact(self._host_aliases[session_id].history(history, canonical=True),
                                               config.gateway.capability)
                    waiting = run.response_meta()
                    # The last real switch names the model that actually answered; a turn that
                    # started on a fallback because the primary's breaker is open reports that skip.
                    switched = (uses[-1] if uses else getattr(state.agent, "_chisabot_breaker_skip", None))
                    used = fallback_use(config.model_id, *switched) if switched else None
                    meta = {**(waiting or {}), **({"modelFallback": used} if used else {})}
                    if waiting:
                        return PromptResponse(stop_reason="cancelled", field_meta={"chisabot": meta})
                    if state.cancel_event and state.cancel_event.is_set():
                        return PromptResponse(stop_reason="cancelled")
                    if failed_category is not None:
                        # Hermes reports an exhausted model call as a result, not an exception, with
                        # its own English warning as final_response. Surface it as a turn error the
                        # web app can classify (rate limit, too long, timeout...) instead of a reply.
                        raise acp.RequestError(-32603, failure_message(failed_category))
                    final = result.get("final_response")
                    if final and conn and (not cbs.streamed or result.get("response_transformed")):
                        update = acp.update_agent_message_text(redact(final, config.gateway.capability))
                        update.message_id = state.message_ids.current()
                        await conn.session_update(session_id, update)
                    return PromptResponse(stop_reason="cancelled" if result.get("interrupted") else "end_turn",
                                          **({"field_meta": {"chisabot": meta}} if meta else {}))
                except asyncio.CancelledError:
                    run.close()
                    request_hard_interrupt(state.agent)
                    raise
                except acp.RequestError:
                    raise
                except Exception as error:
                    try:
                        self._observe_turn(state, config,
                                           list(getattr(state.agent, "_chisabot_fallback_uses", None) or []),
                                           finished=False, failure=failure_category(error=error),
                                           had_output=first_output.is_set())
                    except Exception:
                        pass
                    # Only a fixed category sentence leaves the process, never the provider's text.
                    try:
                        message = failure_message(failure_category(error=error))
                    except Exception:
                        # Classifying must never keep run.fail from running, or the run hangs.
                        message = TURN_FAILED
                    run.fail(message)
                    raise acp.RequestError(-32603, message) from None
                finally:
                    run.close()
                    self._host_runs.pop(session_id, None)
                    active_run.reset(token)
                    with state.runtime_lock:
                        state.is_running = False
                        state.current_prompt_text = ""
                        state.interrupted_prompt_text = ""
                    state.agent.ephemeral_system_prompt = None
                    state.agent._chisabot_fallback_uses = None
                    state.agent._chisabot_breaker_skip = None
                    state.agent._chisabot_turn_model = None
                    for attr in ("tool_start_callback", "tool_complete_callback", "tool_progress_callback",
                                 "step_callback", "stream_delta_callback", "reasoning_callback"):
                        setattr(state.agent, attr, None)

        async def cancel(self, session_id: str, **kwargs):
            run = self._host_runs.get(session_id)
            if run is not None:
                run.close()  # Close HTTP/text gates before asking Hermes to unwind.
            state = await asyncio.to_thread(self.session_manager.get_session, session_id)
            if state is not None:
                if state.cancel_event:
                    state.cancel_event.set()
                request_hard_interrupt(state.agent)

    ChisaBotACPAgent.__name__ = "ChisaBotACPAgent"
    return ChisaBotACPAgent


def check_runtime(agent_class) -> None:
    """Verify the APIs this adapter relies on; do not construct a model/session."""
    from acp_adapter.server import HermesACPAgent
    from acp_adapter.session import SessionManager
    from run_agent import AIAgent
    from tools.registry import registry, session_tool_scope
    from tools.approval_context import _approval_tool_call_id

    requirements = ((registry.register, {"scope", "override", "schema", "handler"}),
                    (registry.snapshot_registration, {"name", "scope"}),
                    (HermesACPAgent._switch_model, {"keep_endpoint"}),
                    (HermesACPAgent.set_session_model, {"model_id", "session_id"}),
                    (AIAgent.__init__, {"tool_start_callback", "tool_complete_callback", "ephemeral_system_prompt",
                                       "skip_memory", "skip_background_review"}))
    if any(not names.issubset(inspect.signature(function).parameters) for function, names in requirements):
        raise ProtocolError("The installed Hermes API is incompatible with the ChisaBot adapter")
    if not callable(session_tool_scope) or not callable(getattr(_approval_tool_call_id, "get", None)):
        raise ProtocolError("The installed Hermes lacks the required session/tool-call ContextVars")
    if not issubclass(agent_class, HermesACPAgent) or not callable(SessionManager.create_session):
        raise ProtocolError("The installed Hermes lacks the required ACP session APIs")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Hermes ACP with ChisaBot-owned host tools")
    parser.add_argument("--check", action="store_true", help="Import and check the existing Hermes/ACP APIs, without a session")
    args = parser.parse_args(argv)
    try:
        configure_source()
        # Do not import acp_adapter.entry: its import-time recovery can mutate
        # the source checkout. Load only the existing environment and formatter.
        logging.basicConfig(stream=sys.stderr, level=logging.INFO,
                            format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
        if not args.check:
            from hermes_cli.env_loader import load_hermes_dotenv
            from hermes_constants import get_hermes_home
            from agent.redact import RedactingFormatter
            load_hermes_dotenv(hermes_home=get_hermes_home())
            for handler in logging.getLogger().handlers:
                handler.setFormatter(RedactingFormatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
        agent_class = build_agent_class()
        check_runtime(agent_class)
        if args.check:
            print("ChisaBot Hermes ACP host-tools v1 check OK")
            return 0
        import acp
        from agent.ssl_verify import install_truststore
        install_truststore()
        agent = agent_class()
        asyncio.run(acp.run_agent(agent, use_unstable_protocol=True))
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception:
        # Do not dump request metadata, provider credentials or exception bodies.
        print("ChisaBot Hermes ACP failed; verify the existing Hermes source, venv and provider configuration", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
