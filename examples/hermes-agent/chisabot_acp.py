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
import logging
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from typing import Any

from chisabot_protocol import (GatewayClient, HostPrompt, ProtocolError, RunState, ToolAliases,
                               TURN_FAILED, active_run, failure_category, failure_message, host_metadata,
                               parse_host_prompt, redact, tool_error)


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
            from hermes_cli.config import load_config
            from hermes_cli.runtime_provider import resolve_runtime_provider
            from hermes_constants import resolve_reasoning_config

            config = load_config()
            model_config = config.get("model")
            default_model = (str(model_config.get("default") or "") if isinstance(model_config, dict)
                             else str(model_config or ""))
            provider = model_config.get("provider") if isinstance(model_config, dict) else None
            selected_model = model or default_model
            route = resolve_runtime_provider(requested=requested_provider or provider, target_model=selected_model or None)
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
            agent = AIAgent(**kwargs)
            restrict(agent)
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

        async def initialize(self, *args, **kwargs):
            response = await super().initialize(*args, **kwargs)
            response.field_meta = {**(response.field_meta or {}), "chisabotHostTools": 1}
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

        async def _configure(self, state, config: HostPrompt):
            session_id = state.session_id
            known_scope = self._host_scopes.get(session_id)
            if known_scope is not None and known_scope != config.scope.session_key:
                raise ProtocolError("ACP session scope does not match actorId, botId and threadId")
            aliases = tool_aliases(config)
            if self._host_models.get(session_id) != config.model_id:
                try:
                    # Native method validates unknown models and passes keep_endpoint=True
                    # to _switch_model: the configured server Magpie route survives.
                    response = await super().set_session_model(model_id=config.model_id, session_id=session_id)
                except Exception:
                    raise ProtocolError("The requested host model was rejected or could not be configured") from None
                if response is None:
                    raise ProtocolError("The requested host model could not be configured")
                self._host_models[session_id] = config.model_id
            agent = state.agent
            restrict(agent)
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
                    agent.tools = registry.get_definitions(installed, quiet=True)
                    agent.valid_tool_names = {t["function"]["name"] for t in agent.tools}
                    if agent.valid_tool_names != installed:
                        raise ProtocolError("Hermes did not expose the complete host tool surface")
            except Exception:
                for name in installed:
                    registry.deregister(name, scope=session_id)
                restrict(agent)
                raise ProtocolError("The scoped host tool surface could not be registered") from None
            self._host_tools[session_id] = installed
            self._host_scopes[session_id] = config.scope.session_key
            self._host_aliases[session_id] = aliases
            state.history = aliases.history(config.history)
            state.queued_prompts.clear()
            state.interrupted_prompt_text = ""
            agent.ephemeral_system_prompt = aliases.text(config.system_prompt)
            if callable(invalidate := getattr(agent, "_invalidate_system_prompt", None)):
                invalidate()

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

        def _wire_turn_callbacks(self, state, session_id, conn, loop):
            run = active_run.get()
            if run is None:
                raise RuntimeError("A host run is required")
            cbs = SimpleNamespace(streamed=False, approval_cb=None, edit_approval_requester=None)
            aliases = self._host_aliases[session_id]
            agent = state.agent
            if state.message_ids is None:
                state.message_ids = AssistantMessageIdAllocator()
            state.message_ids.close()
            text_cb = make_message_cb(conn, session_id, loop, state.message_ids) if conn else None
            thought_cb = make_thinking_cb(conn, session_id, loop, state.message_ids) if conn else None

            def stream(text):
                if run.may_stream() and text_cb:
                    safe = redact(text, run.config.gateway.capability)
                    cbs.streamed = cbs.streamed or bool(safe)
                    text_cb(safe)

            def reasoning(text):
                if run.may_stream() and thought_cb:
                    thought_cb(redact(text, run.config.gateway.capability))

            def start(call_id, name, args):
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
                user_content = (copy.deepcopy(config.current_message["content"]) if config.current_message is not None
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

                def execute():
                    try:
                        return self._run_agent_turn(state=state, session_id=session_id, user_text=user_text,
                                                    user_content=user_content, conn=conn, loop=loop,
                                                    approval_cb=None, edit_approval_requester=None)
                    finally:
                        with run.lock:
                            open_calls = [(call_id, rec.name) for call_id, rec in run.records.items() if not rec.completed]
                        for call_id, name in open_calls:
                            self._complete_tool(run, conn, loop, call_id, name,
                                                tool_error("tool_interrupted", "The host tool ended without a result"),
                                                abandoned=True)

                try:
                    cbs = self._wire_turn_callbacks(state, session_id, conn, loop)
                    ctx = contextvars.copy_context()
                    result = await loop.run_in_executor(None, ctx.run, execute)
                    if run.fatal_error:
                        raise acp.RequestError(-32603, run.fatal_error)
                    if not isinstance(result, dict):
                        raise acp.RequestError(-32603, "Hermes returned an invalid host turn result")
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
                    if waiting:
                        return PromptResponse(stop_reason="cancelled", field_meta={"chisabot": waiting})
                    if state.cancel_event and state.cancel_event.is_set():
                        return PromptResponse(stop_reason="cancelled")
                    if result.get("failed"):
                        # Hermes reports an exhausted model call as a result, not an exception, with
                        # its own English warning as final_response. Surface it as a turn error the
                        # web app can classify (rate limit, too long, timeout...) instead of a reply.
                        raise acp.RequestError(-32603, failure_message(failure_category(result.get("failure_reason"))))
                    final = result.get("final_response")
                    if final and conn and (not cbs.streamed or result.get("response_transformed")):
                        update = acp.update_agent_message_text(redact(final, config.gateway.capability))
                        update.message_id = state.message_ids.current()
                        await conn.session_update(session_id, update)
                    return PromptResponse(stop_reason="cancelled" if result.get("interrupted") else "end_turn")
                except asyncio.CancelledError:
                    run.close()
                    request_hard_interrupt(state.agent)
                    raise
                except acp.RequestError:
                    raise
                except Exception as error:
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
