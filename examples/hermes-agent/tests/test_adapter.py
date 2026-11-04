"""Socket-free contract tests: every Hermes/ACP module below is an explicit fake."""
from __future__ import annotations

import asyncio
import contextvars
import copy
import importlib
import json
import os
from pathlib import Path
import sys
import threading
import time
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch
from contextlib import contextmanager

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_protocol import Response, payload
from chisabot_protocol import GatewayClient, ProtocolError


class Model(SimpleNamespace):
    def __init__(self, **kwargs):
        super().__init__(field_meta=None, **kwargs) if "field_meta" not in kwargs else super().__init__(**kwargs)


class RequestError(Exception):
    def __init__(self, code, message, data=None):
        self.code, self.message, self.data = code, message, data
        super().__init__(message)

    @classmethod
    def invalid_params(cls, data):
        return cls(-32602, data["details"], data)


class Registry:
    def __init__(self):
        self.entries = {}
        self.scope = contextvars.ContextVar("fake_session_scope", default=None)

    @contextmanager
    def session_tool_scope(self, scope):
        token = self.scope.set(scope)
        try:
            yield
        finally:
            self.scope.reset(token)

    @staticmethod
    def normalize_scope(scope):
        # Real Hermes normalizes registration slots, but its explicit get_entry
        # branch uses the raw key. Model that asymmetry instead of masking it.
        return None if scope is None else str(Path(scope).resolve())

    def register(self, name, toolset, schema, handler, scope=None, override=False):
        self.entries[(self.normalize_scope(scope), name)] = SimpleNamespace(name=name, toolset=toolset, schema=schema, handler=handler)

    def get_entry(self, name, *, scope=None):
        key = scope if scope is not None else self.normalize_scope(self.scope.get())
        return self.entries.get((key, name))

    def snapshot_registration(self, name, *, scope=None):
        return self.entries.get((self.normalize_scope(scope), name))

    def get_definitions(self, names, quiet=False):
        return [{"type": "function", "function": copy.deepcopy(self.get_entry(n).schema)} for n in sorted(names)]

    def deregister(self, name, *, scope=None):
        self.entries.pop((self.normalize_scope(scope), name), None)


class FakeAgent:
    def __init__(self):
        self.model, self.provider, self.base_url, self.api_mode = "initial", "custom", "https://magpie.invalid/v1", "chat"
        self.ephemeral_system_prompt = None
        self.tools, self.valid_tool_names = [], set()
        self.session_id = "native-session"
        self.run_hook = None
        self.interrupted = False
        self.inputs = []

    def _invalidate_system_prompt(self):
        pass

    def run_conversation(self, user_message, conversation_history, task_id, persist_user_message):
        self.inputs.append({"user_message": copy.deepcopy(user_message), "history": copy.deepcopy(conversation_history),
                            "system": self.ephemeral_system_prompt, "tools": copy.deepcopy(self.tools)})
        self.interrupted = False
        if self.run_hook:
            return self.run_hook(self, user_message, conversation_history)
        history = copy.deepcopy(conversation_history)
        index = len(history)
        history += [{"role": "user", "content": user_message}, {"role": "assistant", "content": "answer"}]
        self.stream_delta_callback("answer")
        self.stream_delta_callback(None)
        return {"messages": history, "final_response": "answer", "current_turn_user_idx": index}


class FakeSessionManager:
    def __init__(self):
        self.states = {}

    def create_session(self, cwd="."):
        session_id = "session-" + str(len(self.states) + 1)
        state = SimpleNamespace(session_id=session_id, agent=FakeAgent(), cwd=cwd, model="initial", history=[],
                                queued_prompts=[], interrupted_prompt_text="", runtime_lock=threading.Lock(),
                                cancel_event=threading.Event(), is_running=False, command_op=False,
                                current_prompt_text="", message_ids=None)
        self.states[session_id] = state
        return state

    def get_session(self, session_id):
        return self.states.get(session_id)

    def save_session(self, session_id):
        pass


class FakeHermesACPAgent:
    def __new__(cls, session_manager=None):
        if session_manager is None:
            raise AssertionError("must not create Hermes gateway agent")
        return object.__new__(cls)

    def __init__(self, session_manager=None):
        self.session_manager = session_manager
        self._conn = None
        self.switches = []

    async def initialize(self, **kwargs):
        return Model(agent_capabilities=Model(load_session=True, session_capabilities="all"))

    async def set_session_model(self, model_id, session_id, **kwargs):
        self.switches.append(model_id)
        if model_id == "unknown":
            raise RequestError(-32602, "unknown bearer-sensitive provider message")
        state = self.session_manager.get_session(session_id)
        state.agent.model = state.model = model_id
        return Model()

    def _switch_model(self, state, raw_model, *, keep_endpoint=False):
        if raw_model == "unknown":
            raise Exception("model 'unknown' was rejected")
        state.agent.model = state.model = raw_model
        return ("custom", "custom", raw_model)

    def _run_agent_turn(self, *, state, session_id, user_text, user_content, **kwargs):
        return state.agent.run_conversation(user_message=user_content, conversation_history=state.history,
                                            task_id=session_id, persist_user_message=user_text)


class Connection:
    def __init__(self, events, fail_starts=False):
        self.events = events
        self.fail_starts = fail_starts

    async def session_update(self, session_id, update):
        if self.fail_starts and getattr(update, "session_update", None) == "tool_call":
            raise RuntimeError("connection failed with opaque-capability-secret")
        self.events.append(("acp", session_id, update))


class MessageIds:
    def __init__(self):
        self.value = None

    def current(self):
        self.value = self.value or "uuid-message"
        return self.value

    def close(self):
        self.value = None


def fake_modules():
    registry = Registry()
    call_id = contextvars.ContextVar("fake_approval_tool_call_id", default="")
    modules = {}
    def module(name, **attributes):
        mod = ModuleType(name)
        mod.__dict__.update(attributes)
        if name in {"acp", "acp_adapter", "tools", "agent"}:
            mod.__path__ = []
        modules[name] = mod
        return mod
    def text(kind, text):
        return Model(session_update=kind, content=Model(type="text", text=text))
    acp = module("acp", RequestError=RequestError,
                 tool_content=lambda value: Model(type="content", content=value),
                 text_block=lambda text: Model(type="text", text=text),
                 update_agent_message_text=lambda value: text("agent_message_chunk", value))
    module("acp.schema", NewSessionResponse=Model, PromptResponse=Model, ToolCallStart=Model, ToolCallProgress=Model)
    module("acp_adapter")
    module("acp_adapter.server", HermesACPAgent=FakeHermesACPAgent)
    module("acp_adapter.session", SessionManager=FakeSessionManager)
    module("acp_adapter.content", _extract_text=lambda blocks: "".join(b.text for b in blocks if getattr(b, "type", None) == "text"),
           _content_blocks_to_openai_user_content=lambda blocks: "".join(b.text for b in blocks))
    def text_factory(kind):
        def make(conn, session_id, loop, ids):
            def send(value):
                if value is None:
                    ids.close()
                    return
                update = text(kind, value)
                update.message_id = ids.current()
                # Mirror events._send_update's cross-thread delivery, without importing it.
                future = asyncio.run_coroutine_threadsafe(conn.session_update(session_id, update), loop)
                future.result(2)
            return send
        return make
    module("acp_adapter.events", AssistantMessageIdAllocator=MessageIds,
           make_message_cb=text_factory("agent_message_chunk"), make_thinking_cb=text_factory("agent_thought_chunk"))
    module("tools")
    module("tools.registry", registry=registry, session_tool_scope=registry.session_tool_scope)
    module("tools.approval_context", _approval_tool_call_id=call_id)
    module("agent")
    module("agent.interrupt_compat", request_hard_interrupt=lambda agent: setattr(agent, "interrupted", True))
    module("agent.inline_tool_executors", INLINE_TOOL_EXECUTORS={"todo": None, "memory": None})
    module("model_tools", _AGENT_LOOP_TOOLS={"delegate_task", "session_search"}, _LEGACY_TOOL_ALIASES={"todo_list": "todo", "process": "process_manage"})
    return modules, registry, call_id


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.modules, self.registry, self.call_id = fake_modules()
        self.patch = patch.dict(sys.modules, self.modules)
        self.patch.start()
        adapter = importlib.import_module("chisabot_acp")
        self.cls = adapter.build_agent_class()
        self.manager = FakeSessionManager()
        self.events = []
        self.responses = []
        def transport(request, timeout):
            self.events.append(("http", json.loads(request.data), request.get_header("Authorization")))
            return self.responses.pop(0) if self.responses else Response({"result": "host result"})
        self.adapter = self.cls(self.manager, gateway_factory=lambda gateway: GatewayClient(gateway, transport=transport))
        self.adapter._conn = Connection(self.events)
        self.addCleanup(self.patch.stop)

    async def new(self):
        response = await self.adapter.new_session(cwd="/workspace", chisabotNamespace="stable-hash")
        return self.manager.get_session(response.session_id)

    async def prompt(self, state, config=None, text="Current user"):
        return await self.adapter.prompt([Model(type="text", text=text)], state.session_id, chisabot=config or payload())

    def one_tool(self, state, *, after=None, call="provider:id/42", start=True):
        def hook(agent, user, history):
            self.assertEqual(self.registry.scope.get(), state.session_id)
            args = {"limit": 3}
            if start:
                agent.tool_start_callback(call, "device_list", args)
            token = self.call_id.set(call)
            try:
                result = self.registry.get_entry("device_list").handler(args)
            finally:
                self.call_id.reset(token)
            agent.tool_complete_callback(call, "device_list", args, result)
            if after:
                after(agent)
            return {"messages": history + [{"role": "user", "content": user}], "final_response": "must suppress after waiting"}
        state.agent.run_hook = hook

    async def test_initialize_declares_top_level_host_capability(self):
        response = await self.adapter.initialize()
        self.assertEqual(response.field_meta["chisabotHostTools"], 1)
        self.assertEqual(response.agent_capabilities.field_meta["chisabotHostTools"], 1)
        self.assertFalse(response.agent_capabilities.load_session)

    async def test_metadata_required_and_unknown_model_fails_explicitly(self):
        state = await self.new()
        with self.assertRaises(RequestError) as error:
            await self.adapter.prompt([Model(type="text", text="hello")], state.session_id)
        self.assertEqual(error.exception.code, -32602)
        raw = payload()
        raw["model"]["id"] = "unknown"
        with self.assertRaises(RequestError) as error:
            await self.prompt(state, raw)
        self.assertEqual(error.exception.code, -32602)
        self.assertNotIn("bearer-sensitive", str(error.exception))
        self.assertFalse(state.agent.inputs)

    async def test_authoritative_history_and_system_separate_from_prompt(self):
        state = await self.new()
        state.history = [{"role": "user", "content": "obsolete Hermes history"}]
        raw = payload()
        response = await self.prompt(state, raw)
        inputs = state.agent.inputs[0]
        self.assertEqual(inputs["history"], raw["history"])
        self.assertEqual(inputs["system"], "Host identity")
        self.assertEqual(inputs["user_message"], "Current user")
        self.assertEqual(state.agent.base_url, "https://magpie.invalid/v1")
        self.assertEqual(response.stop_reason, "end_turn")
        self.assertEqual(self.adapter.switches, ["magpie-model"])
        self.assertEqual([t["function"]["name"] for t in inputs["tools"]], ["device_list"])
        self.assertNotIn("opaque-capability-secret", json.dumps(inputs))
        self.assertIsNone(state.agent.ephemeral_system_prompt)
        raw["history"] = []
        raw["scope"]["runId"] = "run-2"
        await self.prompt(state, raw)
        self.assertEqual(state.agent.inputs[1]["history"], [])
        self.assertEqual(self.adapter.switches, ["magpie-model"])

    async def test_start_ack_precedes_http_and_id_survives_all_events(self):
        state = await self.new()
        self.one_tool(state)
        await self.prompt(state)
        start = next(e for e in self.events if e[0] == "acp" and e[2].session_update == "tool_call")
        http = next(e for e in self.events if e[0] == "http")
        complete = next(e for e in self.events if e[0] == "acp" and e[2].session_update == "tool_call_update")
        self.assertLess(self.events.index(start), self.events.index(http))
        self.assertEqual(http[1]["callId"], "provider:id/42")
        self.assertEqual(start[2].tool_call_id, http[1]["callId"])
        self.assertEqual(complete[2].tool_call_id, http[1]["callId"])
        self.assertEqual(complete[2].raw_output, "host result")
        self.assertEqual(start[2].field_meta["name"], "device_list")
        self.assertIs(start[2].field_meta["chisabot"]["inputComplete"], True)
        self.assertEqual(start[2].raw_input, http[1]["args"])
        self.assertEqual(http[2], "Bearer opaque-capability-secret")

    async def test_swallowed_start_callback_failure_still_fails_closed(self):
        state = await self.new()
        self.adapter._conn.fail_starts = True
        self.one_tool(state)
        with self.assertRaisesRegex(RequestError, "tool start"):
            await self.prompt(state)
        self.assertFalse(any(e[0] == "http" for e in self.events))
        self.assertFalse(state.is_running)

    async def test_missing_real_contextvar_id_cannot_forge_approval(self):
        state = await self.new()
        def hook(agent, user, history):
            agent.tool_start_callback("real-id", "device_list", {})
            result = self.registry.get_entry("device_list").handler({})  # no ContextVar id
            self.assertEqual(json.loads(result)["error"]["code"], "tool_start_required")
            return {"messages": history, "final_response": ""}
        state.agent.run_hook = hook
        with self.assertRaises(RequestError):
            await self.prompt(state)
        self.assertFalse(any(e[0] == "http" for e in self.events))

    async def test_waiting_metadata_stops_tools_text_and_model_error_reply(self):
        state = await self.new()
        self.responses.append(Response({"error": {"code": "tool_suspended", "message": "approval"},
                                        "waiting": {"kind": "approval", "continuation": {"id": "resume"}}}, 409))
        def after(agent):
            self.assertTrue(agent.interrupted)
            agent.stream_delta_callback("must not stream")
            agent.reasoning_callback("must not think")
            agent.tool_start_callback("second", "device_list", {})
            token = self.call_id.set("second")
            try:
                self.registry.get_entry("device_list").handler({})
            finally:
                self.call_id.reset(token)
        self.one_tool(state, after=after)
        response = await self.prompt(state)
        self.assertEqual(response.stop_reason, "cancelled")
        meta = response.field_meta["chisabot"]
        self.assertEqual(meta, {"version": 1, "callId": "provider:id/42", "name": "device_list",
                                "waiting": {"kind": "approval", "continuation": {"id": "resume"}}})
        self.assertEqual(sum(e[0] == "http" for e in self.events), 1)
        update = next(e[2] for e in self.events if e[0] == "acp" and e[2].session_update == "tool_call_update")
        self.assertEqual(update.status, "pending")
        self.assertIsNone(update.raw_output)
        self.assertEqual(update.field_meta["chisabot"]["waiting"], meta["waiting"])
        self.assertFalse(any(e[0] == "acp" and e[2].session_update in {"agent_message_chunk", "agent_thought_chunk"} for e in self.events))

    async def test_scope_isolation_and_schema_replacement(self):
        state = await self.new()
        await self.prompt(state)
        other = await self.new()
        other_payload = payload()
        other_payload["scope"]["actorId"] = "other-actor"
        other_payload["tools"][0]["description"] = "other schema"
        await self.prompt(other, other_payload)
        self.assertNotEqual(self.registry.snapshot_registration("device_list", scope=state.session_id).schema,
                            self.registry.snapshot_registration("device_list", scope=other.session_id).schema)
        raw = payload()
        raw["scope"]["actorId"] = "other-actor"
        with self.assertRaises(RequestError):
            await self.prompt(state, raw)
        raw = payload()
        raw["tools"] = []
        await self.prompt(state, raw)
        self.assertIsNone(self.registry.snapshot_registration("device_list", scope=state.session_id))
        self.assertEqual(state.agent.tools, [])
        self.assertIsNotNone(self.registry.snapshot_registration("device_list", scope=other.session_id))

    async def test_normalized_registration_uses_slot_snapshot_not_raw_lookup(self):
        state = await self.new()
        await self.prompt(state)
        self.assertIsNone(self.registry.get_entry("device_list", scope=state.session_id))
        entry = self.registry.snapshot_registration("device_list", scope=state.session_id)
        self.assertIsNotNone(entry)
        self.assertEqual(entry.toolset, "chisabot")
        with self.registry.session_tool_scope(state.session_id):
            self.assertIs(self.registry.get_entry("device_list"), entry)
            self.assertEqual(self.registry.get_definitions({"device_list"})[0]["function"]["name"], "device_list")

    async def test_inline_alias_and_connector_names_only_offer_safe_schemas(self):
        state = await self.new()
        names = ("todo", "memory", "delegate_task", "session_search", "todo_list", "process", "tool_call",
                 "tool_search", "tool_describe", "manage_connections", "connectors__x__y")
        raw = payload()
        raw["tools"] = [{**copy.deepcopy(raw["tools"][0]), "name": name} for name in names]
        await self.prompt(state, raw)
        self.assertEqual(state.agent.valid_tool_names, {"chisabot_host_" + name for name in names})
        for name in names:
            with self.subTest(name=name):
                self.assertIsNone(self.registry.snapshot_registration(name, scope=state.session_id))
                self.assertIsNotNone(self.registry.snapshot_registration("chisabot_host_" + name, scope=state.session_id))

    async def test_delegate_alias_uses_original_gateway_name_and_event_id(self):
        state = await self.new()
        raw = payload()
        raw["tools"][0]["name"] = "delegate_task"
        raw["tools"][0]["description"] = "Run delegate_task through the host"
        raw["systemPrompt"] = "Use `delegate_task` for workers; delegate_task_extra stays text."
        raw["history"][1]["tool_calls"][0]["function"] = {"name": "delegate_task", "arguments": '{"label":"delegate_task"}'}
        raw["history"][2].update(name="delegate_task", tool_name="delegate_task", content='{"value":"delegate_task"}')
        original = copy.deepcopy(raw)
        def hook(agent, user, history):
            self.assertEqual(agent.tools[0]["function"]["name"], "chisabot_host_delegate_task")
            self.assertEqual(history[1]["tool_calls"][0]["function"]["name"], "chisabot_host_delegate_task")
            self.assertEqual(history[1]["tool_calls"][0]["function"]["arguments"], '{"label":"delegate_task"}')
            self.assertEqual(history[2]["name"], "chisabot_host_delegate_task")
            self.assertEqual(history[2]["tool_name"], "chisabot_host_delegate_task")
            self.assertEqual(history[2]["content"], '{"value":"delegate_task"}')
            self.assertEqual(agent.ephemeral_system_prompt, "Use `chisabot_host_delegate_task` for workers; delegate_task_extra stays text.")
            self.assertEqual(agent.tools[0]["function"]["description"], "Run chisabot_host_delegate_task through the host")
            args = {"limit": 3, "label": "delegate_task"}
            agent.tool_start_callback("original-provider-id", "chisabot_host_delegate_task", args)
            token = self.call_id.set("original-provider-id")
            try:
                result = self.registry.get_entry("chisabot_host_delegate_task").handler(args)
            finally:
                self.call_id.reset(token)
            agent.tool_complete_callback("original-provider-id", "chisabot_host_delegate_task", args, result)
            return {"messages": history + [{"role": "assistant", "content": None, "tool_calls": [{"id": "original-provider-id",
                      "type": "function", "function": {"name": "chisabot_host_delegate_task", "arguments": json.dumps(args)}}]},
                    {"role": "tool", "tool_call_id": "original-provider-id", "name": "chisabot_host_delegate_task", "content": result}],
                    "final_response": ""}
        state.agent.run_hook = hook
        await self.prompt(state, raw)
        http = next(event[1] for event in self.events if event[0] == "http")
        self.assertEqual(http, {"callId": "original-provider-id", "name": "delegate_task", "args": {"limit": 3, "label": "delegate_task"}})
        tools = [event[2] for event in self.events if event[0] == "acp" and event[2].session_update.startswith("tool_call")]
        self.assertEqual([event.tool_call_id for event in tools], ["original-provider-id", "original-provider-id"])
        self.assertTrue(all(event.field_meta["name"] == "delegate_task" for event in tools))
        self.assertEqual(state.history[1]["tool_calls"][0]["function"]["name"], "delegate_task")
        self.assertEqual(state.history[2]["name"], "delegate_task")
        self.assertEqual(state.history[-2]["tool_calls"][0]["function"]["name"], "delegate_task")
        self.assertEqual(state.history[-1]["name"], "delegate_task")
        self.assertEqual(raw, original)

    async def test_alias_waiting_metadata_keeps_canonical_name_and_original_id(self):
        state = await self.new()
        raw = payload()
        raw["tools"][0]["name"] = "delegate_task"
        self.responses.append(Response({"error": {"code": "tool_suspended"},
                                        "waiting": {"kind": "approval", "continuation": {"id": "resume"}}}, 409))
        def hook(agent, user, history):
            agent.tool_start_callback("delegate-provider-id", "chisabot_host_delegate_task", {})
            token = self.call_id.set("delegate-provider-id")
            try:
                result = self.registry.get_entry("chisabot_host_delegate_task").handler({})
            finally:
                self.call_id.reset(token)
            agent.tool_complete_callback("delegate-provider-id", "chisabot_host_delegate_task", {}, result)
            return {"messages": history, "final_response": "must not escape waiting"}
        state.agent.run_hook = hook
        response = await self.prompt(state, raw)
        self.assertEqual(response.stop_reason, "cancelled")
        self.assertEqual(response.field_meta["chisabot"]["name"], "delegate_task")
        self.assertEqual(response.field_meta["chisabot"]["callId"], "delegate-provider-id")
        update = next(event[2] for event in self.events if event[0] == "acp" and event[2].session_update == "tool_call_update")
        self.assertEqual(update.status, "pending")
        self.assertEqual(update.field_meta["name"], "delegate_task")
        self.assertEqual(update.tool_call_id, "delegate-provider-id")
        self.assertEqual(next(event[1]["name"] for event in self.events if event[0] == "http"), "delegate_task")

    async def test_alias_collision_is_rejected_before_model_or_registration(self):
        state = await self.new()
        raw = payload()
        raw["tools"] = [{**copy.deepcopy(raw["tools"][0]), "name": name}
                        for name in ("delegate_task", "chisabot_host_delegate_task")]
        with self.assertRaisesRegex(RequestError, "collides"):
            await self.prompt(state, raw)
        self.assertFalse(state.agent.inputs)
        self.assertFalse(self.registry.entries)

    async def test_historical_reserved_tools_map_without_restoring_their_permission(self):
        state = await self.new()
        raw = payload()
        raw["history"][1]["tool_calls"][0]["function"]["name"] = "delegate_task"
        raw["history"][2]["name"] = "delegate_task"
        await self.prompt(state, raw)
        self.assertEqual(state.agent.inputs[0]["history"][1]["tool_calls"][0]["function"]["name"], "chisabot_host_delegate_task")
        self.assertEqual(state.agent.inputs[0]["history"][2]["name"], "chisabot_host_delegate_task")
        self.assertEqual(state.agent.valid_tool_names, {"device_list"})
        self.assertIsNone(self.registry.snapshot_registration("chisabot_host_delegate_task", scope=state.session_id))
        self.assertEqual(state.history[1]["tool_calls"][0]["function"]["name"], "delegate_task")

    async def test_alias_registry_and_reverse_map_are_session_scoped(self):
        first, second = await self.new(), await self.new()
        raw = payload()
        raw["tools"][0]["name"] = "delegate_task"
        await self.prompt(first, raw)
        second_raw = copy.deepcopy(raw)
        second_raw["scope"]["actorId"] = "second-actor"
        second_raw["tools"][0]["description"] = "second host delegation"
        await self.prompt(second, second_raw)
        first_entry = self.registry.snapshot_registration("chisabot_host_delegate_task", scope=first.session_id)
        second_entry = self.registry.snapshot_registration("chisabot_host_delegate_task", scope=second.session_id)
        self.assertIsNot(first_entry.handler, second_entry.handler)
        self.assertNotEqual(first_entry.schema["description"], second_entry.schema["description"])
        self.assertIsNot(self.adapter._host_aliases[first.session_id], self.adapter._host_aliases[second.session_id])
        raw["tools"] = []
        await self.prompt(first, raw)
        self.assertIsNone(self.registry.snapshot_registration("chisabot_host_delegate_task", scope=first.session_id))
        self.assertIs(self.registry.snapshot_registration("chisabot_host_delegate_task", scope=second.session_id), second_entry)

    async def test_continuation_instruction_does_not_become_canonical_history(self):
        state = await self.new()
        raw = payload()
        raw["continuation"] = True
        await self.prompt(state, raw, "Continue after the tool result")
        self.assertEqual(state.agent.inputs[0]["history"], raw["history"])
        self.assertEqual(state.agent.inputs[0]["user_message"], "Continue after the tool result")
        self.assertEqual(state.history, raw["history"] + [{"role": "assistant", "content": "answer"}])
        self.assertEqual(sum(row.get("content") == "Earlier question" for row in state.history), 1)

    async def test_current_message_overrides_lossy_acp_multimodal_conversion(self):
        state = await self.new()
        raw = payload()
        raw["currentMessage"] = {"role": "user", "content": [{"type": "text", "text": "picture"},
            {"type": "image_url", "image_url": {"url": "https://images.invalid/x.png", "detail": "high"}}]}
        await self.prompt(state, raw, "picture")
        self.assertEqual(state.agent.inputs[0]["user_message"], raw["currentMessage"]["content"])

    async def test_native_slash_command_stays_user_text(self):
        state = await self.new()
        await self.prompt(state, text="/model secret")
        self.assertEqual(state.agent.inputs[0]["user_message"], "/model secret")
        self.assertEqual(self.adapter.switches, ["magpie-model"])

    async def test_cancel_closes_http_and_streaming_gates(self):
        state = await self.new()
        entered, release = threading.Event(), threading.Event()
        def hook(agent, user, history):
            entered.set()
            self.assertTrue(release.wait(2))
            agent.tool_start_callback("after-cancel", "device_list", {})
            token = self.call_id.set("after-cancel")
            try:
                result = self.registry.get_entry("device_list").handler({})
                self.assertEqual(json.loads(result)["error"]["code"], "run_closed")
            finally:
                self.call_id.reset(token)
            agent.stream_delta_callback("must not stream after cancel")
            return {"messages": history, "final_response": "must not publish after cancel"}
        state.agent.run_hook = hook
        pending = asyncio.create_task(self.prompt(state))
        self.assertTrue(await asyncio.to_thread(entered.wait, 2))
        await self.adapter.cancel(state.session_id)
        release.set()
        response = await pending
        self.assertEqual(response.stop_reason, "cancelled")
        self.assertFalse(any(e[0] == "http" for e in self.events))
        self.assertFalse(any(e[0] == "acp" and e[2].session_update == "agent_message_chunk" for e in self.events))

    async def test_callback_setup_failure_cleans_up_turn_state(self):
        state = await self.new()
        with patch.object(self.adapter, "_wire_turn_callbacks", side_effect=RuntimeError("opaque-capability-secret")):
            with self.assertRaises(RequestError) as error:
                await self.prompt(state)
        self.assertEqual(str(error.exception), "Hermes host turn execution failed")
        self.assertFalse(state.is_running)
        self.assertEqual(self.adapter._host_runs, {})
        from chisabot_protocol import active_run
        self.assertIsNone(active_run.get())

    def model_control_modules(self, chains):
        class AIAgent:
            def __init__(self, *, model=None, max_tokens=None, fallback_model=None, ephemeral_system_prompt=None):
                pass

            def _try_activate_fallback(self, reason=None, reset_at=None):
                return False

        def init_chain(agent, chain):
            chains.append(copy.deepcopy(chain))
            agent._fallback_chain, agent._fallback_index = list(chain), 0

        modules = {"run_agent": ModuleType("run_agent"), "agent.agent_init_fallback": ModuleType("agent.agent_init_fallback")}
        modules["run_agent"].AIAgent = AIAgent
        modules["agent.agent_init_fallback"]._init_fallback_chain = init_chain
        return modules

    async def test_backup_models_and_output_cap_reach_hermes_and_switch_is_reported(self):
        chains = []
        with patch.dict(sys.modules, self.model_control_modules(chains)):
            response = await self.adapter.initialize()
            self.assertEqual(response.field_meta["chisabotModelControls"], {"fallback": True, "maxOutputTokens": True})
            state = await self.new()
            state.agent.max_tokens = 4096

            def switch(agent, reason=None, reset_at=None):
                if agent._fallback_index >= len(agent._fallback_chain):
                    return False
                agent.model = agent._fallback_chain[agent._fallback_index]["model"]
                agent._fallback_index += 1
                return True
            state.agent._try_activate_fallback = lambda reason=None, reset_at=None: switch(state.agent, reason, reset_at)

            def hook(agent, user, history):
                self.assertEqual(agent.max_tokens, 32000)
                self.assertTrue(agent._try_activate_fallback(reason=SimpleNamespace(value="rate_limit")))
                return {"messages": history + [{"role": "user", "content": user}], "final_response": "answer"}
            state.agent.run_hook = hook
            raw = payload()
            raw["model"].update({"fallbacks": ["backup-a", "magpie-model", "backup-b", "backup-a"], "maxOutputTokens": 32000})
            response = await self.prompt(state, raw)
            self.assertEqual(chains[-1], [{"provider": "custom", "model": "backup-a", "base_url": "https://magpie.invalid/v1"},
                                          {"provider": "custom", "model": "backup-b", "base_url": "https://magpie.invalid/v1"}])
            self.assertEqual(response.stop_reason, "end_turn")
            self.assertEqual(response.field_meta["chisabot"]["modelFallback"],
                             {"from": "magpie-model", "to": "backup-a", "reason": "quota"})
            # Next turn: no cap from the host restores Hermes' own default; no switch, no metadata.
            state.agent.run_hook = None
            raw2 = payload()
            raw2["scope"]["runId"] = "run-2"
            response = await self.prompt(state, raw2)
            self.assertEqual(state.agent.max_tokens, 4096)
            self.assertEqual(chains[-1], [])
            self.assertIsNone(response.field_meta)

    async def test_mock_hermes_429_walks_to_the_backup_model_and_the_switch_is_reported(self):
        chains = []
        with patch.dict(sys.modules, self.model_control_modules(chains)):
            await self.adapter.initialize()
            state = await self.new()
            calls = []

            class RateLimited(Exception):
                status_code = 429

            def provider(model):
                calls.append(model)
                if model == "magpie-model":
                    raise RateLimited("Error code: 429 - quota exhausted for magpie-model")
                return f"answer from {model}"

            def try_activate_fallback(agent, reason=None, reset_at=None):
                # Hermes' chain walk: the next entry built by _init_fallback_chain becomes the live model.
                if agent._fallback_index >= len(agent._fallback_chain):
                    return False
                agent.model = agent._fallback_chain[agent._fallback_index]["model"]
                agent._fallback_index += 1
                return True
            state.agent._try_activate_fallback = lambda reason=None, reset_at=None: try_activate_fallback(state.agent, reason, reset_at)

            def hermes_turn(agent, user, history):
                # Mirrors Hermes' turn recovery: a 429 is classified rate_limit (should_fallback), the
                # agent switches to the next backup and retries the same request.
                agent.model = "magpie-model"
                for _ in range(3):
                    try:
                        text = provider(agent.model)
                        break
                    except RateLimited:
                        if not agent._try_activate_fallback(reason=SimpleNamespace(value="rate_limit")):
                            raise
                return {"messages": history + [{"role": "user", "content": user}, {"role": "assistant", "content": text}],
                        "final_response": text}
            state.agent.run_hook = hermes_turn
            raw = payload()
            raw["model"]["fallbacks"] = ["backup-a", "backup-b"]
            response = await self.prompt(state, raw)
            self.assertEqual(calls, ["magpie-model", "backup-a"])
            self.assertEqual(response.stop_reason, "end_turn")
            self.assertEqual(response.field_meta["chisabot"]["modelFallback"],
                             {"from": "magpie-model", "to": "backup-a", "reason": "quota"})

    def breaker_turn(self, down):
        """A fake Hermes turn: call the live model; on failure walk the fallback chain like upstream."""
        calls = []

        class Unavailable(Exception):
            status_code = 503

        def provider(model):
            calls.append(model)
            if down.get(model):
                raise Unavailable("Error code: 503 - service unavailable")
            return f"answer from {model}"

        def walk(agent, reason=None, reset_at=None):
            # Hermes' chain walk: the next entry built by _init_fallback_chain becomes the live model.
            if agent._fallback_index >= len(agent._fallback_chain):
                return False
            agent.model = agent._fallback_chain[agent._fallback_index]["model"]
            agent._fallback_index += 1
            return True

        def hermes_turn(agent, user, history):
            for _ in range(3):
                try:
                    text = provider(agent.model)
                    break
                except Unavailable:
                    if not agent._try_activate_fallback(reason=SimpleNamespace(value="server_error")):
                        raise
            return {"messages": history + [{"role": "user", "content": user}, {"role": "assistant", "content": text}],
                    "final_response": text}
        return calls, walk, hermes_turn

    async def test_breaker_skips_cooled_primary_until_a_probe_recovers_it(self):
        # QA1102-06: a dead primary must not cost the full upstream timeout every turn.
        import chisabot_acp
        chains = []
        down = {"magpie-model": True}
        calls, walk, hermes_turn = self.breaker_turn(down)
        clock = [1_000.0]
        original_now = chisabot_acp._now
        chisabot_acp._now = lambda: clock[0]
        self.addCleanup(lambda: setattr(chisabot_acp, "_now", original_now))
        self.addCleanup(chisabot_acp.reset_model_breakers)
        with patch.dict(sys.modules, self.model_control_modules(chains)):
            await self.adapter.initialize()
            state = await self.new()
            agent = state.agent
            agent._try_activate_fallback = lambda reason=None, reset_at=None: walk(agent, reason, reset_at)
            agent.run_hook = hermes_turn

            def raw(run_id):
                data = payload()
                data["scope"]["runId"] = run_id
                data["model"]["fallbacks"] = ["backup-a", "backup-b"]
                return data

            response = await self.prompt(state, raw("run-1"))
            self.assertEqual(calls, ["magpie-model", "backup-a"])
            self.assertEqual(response.field_meta["chisabot"]["modelFallback"],
                             {"from": "magpie-model", "to": "backup-a", "reason": "unavailable"})
            # Inside the cooldown the primary is never dialed again, and the skip is reported.
            for run_id in ("run-2", "run-3"):
                calls.clear()
                response = await self.prompt(state, raw(run_id))
                self.assertEqual(calls, ["backup-a"])
                self.assertEqual(response.field_meta["chisabot"]["modelFallback"],
                                 {"from": "magpie-model", "to": "backup-a", "reason": "unavailable"})
            # Half-open probe after the cooldown: one primary call, still dead → re-open longer.
            calls.clear()
            clock[0] += 61
            response = await self.prompt(state, raw("run-4"))
            self.assertEqual(calls, ["magpie-model", "backup-a"])
            # The doubled cooldown still gates 61s later.
            calls.clear()
            clock[0] += 61
            response = await self.prompt(state, raw("run-5"))
            self.assertEqual(calls, ["backup-a"])
            # The probe after that succeeds → breaker closes → the next turn uses the primary.
            down["magpie-model"] = False
            calls.clear()
            clock[0] += 121
            response = await self.prompt(state, raw("run-6"))
            self.assertEqual(calls, ["magpie-model"])
            self.assertIsNone(response.field_meta)
            calls.clear()
            response = await self.prompt(state, raw("run-7"))
            self.assertEqual(calls, ["magpie-model"])
            self.assertIsNone(response.field_meta)

    async def test_breaker_is_shared_across_sessions(self):
        # The adapter process serves every actor/bot: a dead primary is skipped everywhere.
        import chisabot_acp
        chains = []
        down = {"magpie-model": True}
        calls, walk, hermes_turn = self.breaker_turn(down)
        self.addCleanup(chisabot_acp.reset_model_breakers)
        with patch.dict(sys.modules, self.model_control_modules(chains)):
            await self.adapter.initialize()
            state = await self.new()
            state.agent._try_activate_fallback = lambda reason=None, reset_at=None: walk(state.agent, reason, reset_at)
            state.agent.run_hook = hermes_turn
            raw = payload()
            raw["model"]["fallbacks"] = ["backup-a"]
            await self.prompt(state, raw)
            self.assertEqual(calls, ["magpie-model", "backup-a"])
            # A different session (another user/bot) never pays for the primary either.
            calls.clear()
            other = await self.new()
            other.agent._try_activate_fallback = lambda reason=None, reset_at=None: walk(other.agent, reason, reset_at)
            other.agent.run_hook = hermes_turn
            raw2 = payload()
            raw2["model"]["fallbacks"] = ["backup-a"]
            response = await self.prompt(other, raw2)
            self.assertEqual(calls, ["backup-a"])
            self.assertEqual(response.field_meta["chisabot"]["modelFallback"]["to"], "backup-a")

    def hanging_turn(self, down, calls):
        """A fake Hermes turn: dead models hang until the adapter's deadline interrupts them."""
        def hermes_turn(agent, user, history):
            calls.append(agent.model)
            if down.get(agent.model):
                while not agent.interrupted:
                    time.sleep(0.005)
                return {"messages": history, "interrupted": True}
            text = f"answer from {agent.model}"
            agent.stream_delta_callback(text)
            return {"messages": history + [{"role": "user", "content": user}, {"role": "assistant", "content": text}],
                    "final_response": text}
        return hermes_turn

    async def test_first_token_timeout_interrupts_and_retries_on_the_backup(self):
        # QA1102-06: a hung primary is interrupted at the first-token deadline and the turn
        # retries on a fallback, instead of paying the full upstream call timeout.
        import chisabot_acp
        calls = []
        down = {"magpie-model": True}
        self.addCleanup(chisabot_acp.reset_model_breakers)
        state = await self.new()
        state.agent.run_hook = self.hanging_turn(down, calls)

        def raw(run_id):
            data = payload()
            data["scope"]["runId"] = run_id
            data["model"]["fallbacks"] = ["backup-a"]
            return data

        with patch.dict(os.environ, {"CHISABOT_FIRST_TOKEN_TIMEOUT_S": "0.05"}):
            response = await self.prompt(state, raw("run-1"))
            self.assertEqual(calls, ["magpie-model", "backup-a"])
            self.assertEqual(response.stop_reason, "end_turn")
            self.assertEqual(response.field_meta["chisabot"]["modelFallback"],
                             {"from": "magpie-model", "to": "backup-a", "reason": "unavailable"})
            # The timeout opened the primary's breaker: the next turn dials the backup directly.
            calls.clear()
            response = await self.prompt(state, raw("run-2"))
            self.assertEqual(calls, ["backup-a"])
            self.assertEqual(response.field_meta["chisabot"]["modelFallback"]["to"], "backup-a")

    async def test_deadline_abandons_a_request_that_ignores_the_interrupt(self):
        # QA1102-06 r1：上游不理 request_hard_interrupt（阻塞读）时，整轮不能等满挂起时长——
        # 到点放弃这次请求，让它在后台自己跑完；迟到的结果不得漏进这一轮。
        import chisabot_acp
        calls = []
        self.addCleanup(chisabot_acp.reset_model_breakers)
        state = await self.new()

        def hermes_turn(agent, user, history):
            calls.append(agent.model)
            if agent.model == "magpie-model":
                time.sleep(2.0)  # 阻塞读：agent.interrupted 置位也不醒
                return {"messages": history, "final_response": "late answer from hung primary"}
            text = "answer from backup-a"
            agent.stream_delta_callback(text)
            return {"messages": history + [{"role": "user", "content": user},
                                           {"role": "assistant", "content": text}],
                    "final_response": text}

        state.agent.run_hook = hermes_turn
        raw = payload()
        raw["model"]["fallbacks"] = ["backup-a"]
        with patch.dict(os.environ, {"CHISABOT_FIRST_TOKEN_TIMEOUT_S": "0.3"}):
            t0 = time.monotonic()
            response = await self.prompt(state, raw)
            elapsed = time.monotonic() - t0
        # 300ms 的期限 + 余量，绝不能接近 2s 的挂起时长。
        self.assertLess(elapsed, 0.9)
        self.assertEqual(calls, ["magpie-model", "backup-a"])
        self.assertEqual(response.stop_reason, "end_turn")
        self.assertEqual(response.field_meta["chisabot"]["modelFallback"],
                         {"from": "magpie-model", "to": "backup-a", "reason": "unavailable"})
        # 等被放弃的那次在后台跑完：迟到的 final_response 不进历史、不进流出文本。
        time.sleep(2.2)
        self.assertNotIn("late answer", json.dumps(state.history, ensure_ascii=False))
        texts = [e[2].content.text for e in self.events
                 if e[0] == "acp" and e[2].session_update == "agent_message_chunk"]
        self.assertFalse(any("late answer" in t for t in texts))

    async def test_half_open_probe_is_bounded_by_the_first_token_deadline(self):
        # After the cooldown the probe dials the primary once; a hung probe is interrupted at
        # the first-token deadline (not the upstream timeout), re-opens and uses the backup.
        import chisabot_acp
        calls = []
        down = {"magpie-model": True}
        clock = [1_000.0]
        original_now = chisabot_acp._now
        chisabot_acp._now = lambda: clock[0]
        self.addCleanup(lambda: setattr(chisabot_acp, "_now", original_now))
        self.addCleanup(chisabot_acp.reset_model_breakers)
        state = await self.new()
        state.agent.run_hook = self.hanging_turn(down, calls)

        def raw(run_id):
            data = payload()
            data["scope"]["runId"] = run_id
            data["model"]["fallbacks"] = ["backup-a"]
            return data

        with patch.dict(os.environ, {"CHISABOT_FIRST_TOKEN_TIMEOUT_S": "0.05"}):
            response = await self.prompt(state, raw("run-1"))
            self.assertEqual(calls, ["magpie-model", "backup-a"])
            # Past the 60s cooldown the half-open probe still pays only the first-token deadline.
            calls.clear()
            clock[0] += 61
            response = await self.prompt(state, raw("run-2"))
            self.assertEqual(calls, ["magpie-model", "backup-a"])
            self.assertEqual(response.field_meta["chisabot"]["modelFallback"]["to"], "backup-a")
            # Re-opened (doubled cooldown): the next turn skips the primary again.
            calls.clear()
            response = await self.prompt(state, raw("run-3"))
            self.assertEqual(calls, ["backup-a"])

    async def test_mid_stream_error_counts_a_failure_without_cooling_the_model(self):
        # Output already produced, then the call dies: one consecutive failure is counted but
        # the breaker does not open -- the error still propagates, no switch this turn.
        import chisabot_acp
        calls = []
        self.addCleanup(chisabot_acp.reset_model_breakers)
        state = await self.new()

        class Unavailable(Exception):
            status_code = 503

        def hook(agent, user, history):
            calls.append(agent.model)
            agent.stream_delta_callback("partial answer")
            raise Unavailable("Error code: 503 - service unavailable")

        state.agent.run_hook = hook
        with self.assertRaises(RequestError) as error:
            await self.prompt(state)
        self.assertEqual(str(error.exception), "Hermes model call failed: service unavailable (HTTP 503)")
        entry = chisabot_acp._MODEL_BREAKERS[("custom", "https://magpie.invalid/v1", "magpie-model")]
        self.assertEqual(entry["failures"], 1)
        self.assertLessEqual(entry["open_until"], chisabot_acp._now())
        # No cooldown: the next turn dials the primary again.
        with self.assertRaises(RequestError):
            await self.prompt(state)
        self.assertEqual(calls, ["magpie-model", "magpie-model"])

    async def test_hermes_compression_is_off_only_for_runs_the_host_already_compacted(self):
        state = await self.new()
        state.agent.compression_enabled = True
        seen = []

        def hook(agent, user, history):
            seen.append(agent.compression_enabled)
            return {"messages": history + [{"role": "user", "content": user}], "final_response": "ok"}
        state.agent.run_hook = hook
        raw = payload()
        raw["model"]["contextCompression"] = False
        await self.prompt(state, raw)
        raw2 = payload()
        raw2["scope"]["runId"] = "run-2"
        await self.prompt(state, raw2)
        self.assertEqual(seen, [False, True])

    async def test_unsupported_hermes_advertises_no_model_controls_and_is_left_alone(self):
        response = await self.adapter.initialize()
        self.assertEqual(response.field_meta["chisabotModelControls"], {"fallback": False, "maxOutputTokens": False})
        state = await self.new()
        raw = payload()
        raw["model"].update({"fallbacks": ["backup-a"], "maxOutputTokens": 32000})
        response = await self.prompt(state, raw)
        self.assertEqual(response.stop_reason, "end_turn")
        self.assertFalse(hasattr(state.agent, "_fallback_chain"))
        self.assertFalse(hasattr(state.agent, "max_tokens"))

    async def test_failed_model_result_becomes_classified_turn_error(self):
        state = await self.new()
        def hook(agent, user, history):
            return {"messages": history, "final_response": "⚠️ provider said opaque-provider-text",
                    "failed": True, "error": "opaque-provider-text", "failure_reason": "rate_limit"}
        state.agent.run_hook = hook
        with self.assertRaises(RequestError) as error:
            await self.prompt(state)
        self.assertEqual(error.exception.code, -32603)
        self.assertEqual(str(error.exception), "Hermes model call failed: rate_limit (HTTP 429)")
        self.assertFalse(any(e[0] == "acp" and e[2].session_update == "agent_message_chunk" for e in self.events))
        self.assertFalse(state.is_running)

    async def test_provider_prose_reply_becomes_classified_turn_error(self):
        state = await self.new()
        def hook(agent, user, history):
            return {"messages": history + [{"role": "user", "content": user}],
                    "final_response": ("custom rejected your API key, so the model can't be reached. "
                                       "Update it in Settings → Providers, or run `hermes setup` in a terminal.\n\n"
                                       "Provider said: HTTP 401: Codex: agent@example.com's sign-in was revoked; sign in again")}
        state.agent.run_hook = hook
        with self.assertRaises(RequestError) as error:
            await self.prompt(state)
        self.assertEqual(error.exception.code, -32603)
        self.assertEqual(str(error.exception), "Hermes model call failed: unauthorized (HTTP 401)")
        self.assertFalse(any(e[0] == "acp" and e[2].session_update == "agent_message_chunk" for e in self.events))

    async def test_streamed_provider_prose_is_dropped_before_the_turn_error(self):
        state = await self.new()
        def hook(agent, user, history):
            agent.stream_delta_callback("custom rejected your API key, so the model can't be reached. "
                                        "Update it in Settings → Providers, or run `hermes setup` in a terminal.")
            agent.stream_delta_callback("Provider said: HTTP 401: Codex: agent@example.com's sign-in was revoked; sign in again")
            return {"messages": history, "failed": True, "failure_reason": "auth"}
        state.agent.run_hook = hook
        with self.assertRaises(RequestError) as error:
            await self.prompt(state)
        self.assertEqual(str(error.exception), "Hermes model call failed: unauthorized (HTTP 401)")
        self.assertFalse(any(e[0] == "acp" and e[2].session_update == "agent_message_chunk" for e in self.events))

    async def test_real_text_before_provider_prose_stays_but_prose_does_not(self):
        state = await self.new()
        def hook(agent, user, history):
            agent.stream_delta_callback("partial answer")
            agent.stream_delta_callback("Provider said: HTTP 401: Codex: agent@example.com's sign-in was revoked")
            return {"messages": history, "failed": True, "failure_reason": "auth"}
        state.agent.run_hook = hook
        with self.assertRaises(RequestError):
            await self.prompt(state)
        texts = [e[2].content.text for e in self.events
                 if e[0] == "acp" and e[2].session_update == "agent_message_chunk"]
        self.assertEqual(texts, ["partial answer"])

    async def test_model_exception_keeps_its_category_but_not_its_text(self):
        state = await self.new()
        class BadRequestError(Exception):
            status_code = 400
            code = "context_length_exceeded"
        def hook(agent, user, history):
            raise BadRequestError("opaque-provider-text sk-secret")
        state.agent.run_hook = hook
        with self.assertRaises(RequestError) as error:
            await self.prompt(state)
        self.assertEqual(str(error.exception), "Hermes model call failed: context_length exceeded")
        self.assertNotIn("opaque", str(error.exception))

    async def test_tool_os_error_stays_generic_not_model_not_found(self):
        state = await self.new()
        def hook(agent, user, history):
            raise FileNotFoundError(2, "No such file or directory", "/srv/secret-path.txt")
        state.agent.run_hook = hook
        with self.assertRaises(RequestError) as error:
            await self.prompt(state)
        self.assertEqual(str(error.exception), "Hermes host turn execution failed")
        self.assertNotIn("secret-path", str(error.exception))

    async def test_run_still_fails_when_classifying_raises(self):
        import chisabot_acp
        state = await self.new()
        def hook(agent, user, history):
            raise ValueError("opaque")
        state.agent.run_hook = hook
        original = chisabot_acp.failure_category
        def explode(*args, **kwargs):
            raise TypeError("classifier bug")
        chisabot_acp.failure_category = explode
        try:
            with self.assertRaises(RequestError) as error:
                await self.prompt(state)
        finally:
            chisabot_acp.failure_category = original
        self.assertEqual(str(error.exception), "Hermes host turn execution failed")
        self.assertFalse(state.is_running)

    async def test_default_manager_skips_native_memory_tools_and_discovery(self):
        captured = {}
        class AIAgent(FakeAgent):
            def __init__(self, **kwargs):
                super().__init__()
                captured.update(kwargs)
        additions = {}
        for name, attrs in {
            "run_agent": {"AIAgent": AIAgent},
            "hermes_cli": {"__path__": []},
            "hermes_cli.config": {"load_config": lambda: {"model": {"default": "magpie-model", "provider": "custom"}},
                                  "get_compatible_custom_providers": lambda _cfg=None: []},
            "hermes_cli.runtime_provider": {"resolve_runtime_provider": lambda **_kw: {"provider": "custom", "base_url": "https://magpie.invalid/v1", "api_mode": "chat", "api_key": "provider-key"}},
            "hermes_constants": {"resolve_reasoning_config": lambda *_a: {"effort": "low"}},
        }.items():
            module = ModuleType(name)
            module.__dict__.update(attrs)
            additions[name] = module
        with patch.dict(sys.modules, additions):
            adapter = self.cls()
            self.assertIsInstance(adapter, self.cls)
            manager = adapter.session_manager
            self.assertIsNone(manager._get_db())
            agent = manager._make_agent(session_id="session", cwd="/workspace", base_url="https://magpie.invalid/pinned")
        for flag in ("skip_memory", "skip_background_review", "skip_context_files"):
            self.assertTrue(captured[flag])
        for flag in ("load_soul_identity", "checkpoints_enabled", "save_trajectories"):
            self.assertFalse(captured[flag])
        self.assertEqual(captured["enabled_toolsets"], [])
        self.assertEqual(captured["base_url"], "https://magpie.invalid/pinned")
        self.assertEqual(agent.tools, [])
        self.assertTrue(agent._persist_disabled)
        self.assertIsNone(agent._session_db)
        self.assertNotIn("hermes_cli.mcp_startup", sys.modules)

    async def test_call_limits_never_inject_max_retries_into_request_overrides(self):
        # 生产事故（2026-11-03）：request_overrides 里的 max_retries 被一路塞进
        # openai>=2.x 的 create()——SDK 不认识这个每请求参数，TypeError 干掉每一次
        # 模型调用（「Hermes host turn execution failed」）。真实 AIAgent.__init__
        # 声明 request_overrides 时走这条注入路径；旧的 **kwargs 桩永远走不到。
        captured = {}
        class AIAgent(FakeAgent):
            _api_max_retries = 3
            def __init__(self, model=None, request_overrides=None, **kwargs):
                super().__init__()
                captured.update(kwargs)
                captured["request_overrides"] = request_overrides
                self.request_overrides = dict(request_overrides or {})
        additions = {}
        for name, attrs in {
            "run_agent": {"AIAgent": AIAgent},
            "hermes_cli": {"__path__": []},
            "hermes_cli.config": {"load_config": lambda: {"model": {"default": "magpie-model", "provider": "custom"}},
                                  "get_compatible_custom_providers": lambda _cfg=None: []},
            "hermes_cli.runtime_provider": {"resolve_runtime_provider": lambda **_kw: {"provider": "custom", "base_url": "https://magpie.invalid/v1", "api_mode": "chat", "api_key": "provider-key"}},
            "hermes_constants": {"resolve_reasoning_config": lambda *_a: {}},
        }.items():
            module = ModuleType(name)
            module.__dict__.update(attrs)
            additions[name] = module
        with patch.dict(sys.modules, additions):
            manager = self.cls().session_manager
            agent = manager._make_agent(session_id="s", cwd="/w", base_url="https://magpie.invalid/v1")
        overrides = captured["request_overrides"] or {}
        self.assertIn("timeout", overrides)
        self.assertNotIn("max_retries", overrides)
        self.assertNotIn("max_retries", agent.request_overrides)
        # 重试上限走 agent 上真实存在的 _api_max_retries 旋钮（env 默认 1）。
        self.assertEqual(agent._api_max_retries, 1)

    async def test_custom_provider_echo_resolves_named_provider_by_endpoint(self):
        # _switch_model echoes the resolved provider type "custom" when a session stays on a
        # named custom provider's endpoint; _make_agent must recover the real name so the
        # runtime resolver does not reject a bare "custom" request (#host-model-switch).
        requested = []
        captured = {}
        class AIAgent(FakeAgent):
            def __init__(self, **kwargs):
                super().__init__()
                captured.update(kwargs)
        additions = {}
        for name, attrs in {
            "run_agent": {"AIAgent": AIAgent},
            "hermes_cli": {"__path__": []},
            "hermes_cli.config": {"load_config": lambda: {"model": {"default": "magpie-model", "provider": "custom"}},
                                  "get_compatible_custom_providers": lambda _cfg=None: [{"name": "magpie", "base_url": "https://magpie.invalid/v1/"}]},
            "hermes_cli.runtime_provider": {"resolve_runtime_provider": lambda **kw: requested.append(kw.get("requested")) or
                                            {"provider": "custom", "base_url": "https://magpie.invalid/v1", "api_key": "k"}},
            "hermes_constants": {"resolve_reasoning_config": lambda *_a: {}},
        }.items():
            module = ModuleType(name)
            module.__dict__.update(attrs)
            additions[name] = module
        with patch.dict(sys.modules, additions):
            manager = self.cls().session_manager
            manager._make_agent(session_id="s", cwd="/w", model="clinepass/x",
                                requested_provider="custom", base_url="https://magpie.invalid/v1")
            manager._make_agent(session_id="s", cwd="/w", model="clinepass/x",
                                requested_provider="custom", base_url="https://unknown.invalid/v1")
        self.assertEqual(requested, ["magpie", "custom"])
        self.assertEqual(captured["model"], "clinepass/x")

    async def test_custom_provider_echo_uses_upstream_identity_lookup(self):
        # 具名 custom provider 反查优先走 upstream canonical identity（规范化 URL、
        # 扫描 providers: 新条目、可按模型反查）；手写 base_url 匹配只是旧版兜底。
        requested = []
        captured = {}
        class AIAgent(FakeAgent):
            def __init__(self, **kwargs):
                super().__init__()
                captured.update(kwargs)
        additions = {}
        for name, attrs in {
            "run_agent": {"AIAgent": AIAgent},
            "hermes_cli": {"__path__": []},
            "hermes_cli.config": {"load_config": lambda: {"model": {"default": "magpie-model", "provider": "custom"}},
                                  "get_compatible_custom_providers": lambda _cfg=None: []},
            "hermes_cli.runtime_provider": {"resolve_runtime_provider": lambda **kw: requested.append(kw.get("requested")) or
                                            {"provider": "custom", "base_url": "https://magpie.invalid/v1", "api_key": "k"},
                                            "canonical_custom_identity": lambda base_url=None, model=None, **kw: "custom:magpie"},
            "hermes_constants": {"resolve_reasoning_config": lambda *_a: {}},
        }.items():
            module = ModuleType(name)
            module.__dict__.update(attrs)
            additions[name] = module
        with patch.dict(sys.modules, additions):
            manager = self.cls().session_manager
            manager._make_agent(session_id="s", cwd="/w", model="SWE-2",
                                requested_provider="custom", base_url="https://magpie.invalid/v1")
        self.assertEqual(requested, ["magpie"])
        self.assertEqual(captured["model"], "SWE-2")

    async def test_configure_rejection_surfaces_upstream_details(self):
        # 根因修复：configure 失败必须带上 Hermes 放在 data.details 里的真实原因，
        # 而不是吞成固定文案——否则「又拒绝」永远不可诊断。
        state = await self.new()
        server_mod = self.modules["acp_adapter.server"]

        async def rejecting(agent_self, model_id, session_id, **kwargs):
            agent_self.switches.append(model_id)
            raise RequestError.invalid_params({"details": "Model `SWE-2` was not found in this provider's model listing"})

        with patch.object(server_mod.HermesACPAgent, "set_session_model", rejecting):
            with self.assertRaises(RequestError) as error:
                await self.prompt(state)
        self.assertEqual(error.exception.code, -32602)
        self.assertIn("SWE-2", str(error.exception))
        self.assertIn("was not found", str(error.exception))
        self.assertFalse(state.agent.inputs)

    async def test_configure_failure_cools_primary_and_falls_back(self):
        # 主模型 configure 失败以前直接硬死每轮；现在冷却它并换下一个健康候选，
        # 一次配错的选型不再让整个机器人永久死锁。
        import chisabot_acp
        self.addCleanup(chisabot_acp.reset_model_breakers)
        state = await self.new()
        server_mod = self.modules["acp_adapter.server"]

        async def flaky(agent_self, model_id, session_id, **kwargs):
            agent_self.switches.append(model_id)
            if model_id == "unknown":
                raise RequestError.invalid_params({"details": "Model `unknown` was not found"})
            target = agent_self.session_manager.get_session(session_id)
            target.agent.model = target.model = model_id
            return Model()

        raw = payload()
        raw["model"]["id"] = "unknown"
        raw["model"]["fallbacks"] = ["backup-a"]
        with patch.object(server_mod.HermesACPAgent, "set_session_model", flaky):
            response = await self.prompt(state, raw)
        self.assertEqual(self.adapter.switches, ["unknown", "backup-a"])
        self.assertEqual(state.agent.model, "backup-a")
        self.assertEqual(response.stop_reason, "end_turn")
        self.assertEqual(response.field_meta["chisabot"]["modelFallback"],
                         {"from": "unknown", "to": "backup-a", "reason": "unavailable"})

    async def test_missing_session_reports_session_loss_not_model_rejection(self):
        # set_session_model 返回 None = 会话本身没了，不是模型拒绝——报不同的错，
        # 也不去逐个冷却无辜的模型。
        import chisabot_acp
        self.addCleanup(chisabot_acp.reset_model_breakers)
        state = await self.new()
        server_mod = self.modules["acp_adapter.server"]

        async def missing(agent_self, model_id, session_id, **kwargs):
            agent_self.switches.append(model_id)
            return None

        raw = payload()
        raw["model"]["fallbacks"] = ["backup-a"]
        with patch.object(server_mod.HermesACPAgent, "set_session_model", missing):
            with self.assertRaises(RequestError) as error:
                await self.prompt(state, raw)
        self.assertIn("session", str(error.exception).lower())
        self.assertIn("new conversation", str(error.exception))
        self.assertEqual(self.adapter.switches, ["magpie-model"])

    async def test_session_level_acp_error_is_not_mislabeled_as_model_rejection(self):
        # -32603 之类会话级失败不是模型拒绝——原样透传，不吞成 invalid_params，
        # 也不冷却一个根本没问题的模型。
        import chisabot_acp
        self.addCleanup(chisabot_acp.reset_model_breakers)
        state = await self.new()
        server_mod = self.modules["acp_adapter.server"]

        async def busy(agent_self, model_id, session_id, **kwargs):
            agent_self.switches.append(model_id)
            raise RequestError(-32603, "Session is busy")

        raw = payload()
        raw["model"]["fallbacks"] = ["backup-a"]
        with patch.object(server_mod.HermesACPAgent, "set_session_model", busy):
            with self.assertRaises(RequestError) as error:
                await self.prompt(state, raw)
        self.assertEqual(error.exception.code, -32603)
        self.assertEqual(str(error.exception), "Session is busy")

    async def test_source_is_pinned_before_bootstrap_and_lazy_installs_disabled(self):
        import os
        adapter = importlib.import_module("chisabot_acp")
        expected = str(Path("/trusted-hermes-stub").resolve())
        bootstrap = ModuleType("hermes_bootstrap")
        seen = []
        def harden():
            seen.append((sys.path[0], os.environ.get("HERMES_DISABLE_LAZY_INSTALLS")))
        bootstrap.harden_import_path = harden
        with patch.object(Path, "is_file", return_value=True), patch.dict(sys.modules, {"hermes_bootstrap": bootstrap}), \
             patch.dict(os.environ, {"HERMES_SOURCE_DIR": expected, "HERMES_DISABLE_LAZY_INSTALLS": "0"}), \
             patch.object(sys, "path", list(sys.path)):
            self.assertEqual(adapter.configure_source(), Path(expected))
            self.assertEqual(sys.path[0], expected)
            self.assertEqual(seen, [(expected, "1")])

    async def test_stdlib_import_does_not_load_hermes(self):
        # Loading the entry module itself has no runtime imports or configure_source side effects.
        self.assertNotIn("run_agent", sys.modules)
        module = importlib.import_module("chisabot_acp")
        self.assertTrue(callable(module.configure_source))
        self.assertNotIn("run_agent", sys.modules)

    async def test_400_rejected_retries_once_cleaned_on_primary_and_never_opens_breaker(self):
        # QA1102-14：请求本身被主模型拒（400 invalid input）——清洗 + 压缩后用主模型重试
        # 一次，不算模型故障、不进断路器，也不重试第三次。
        import chisabot_acp
        self.addCleanup(chisabot_acp.reset_model_breakers)
        state = await self.new()
        calls, sizes = [], []
        class BadRequest(Exception):
            status_code = 400
        def hook(agent, user, history):
            calls.append(agent.model)
            sizes.append(len(history))
            raise BadRequest("Invalid input")
        state.agent.run_hook = hook
        raw = payload()
        raw["history"] = [row for i in range(80)
                          for row in ({"role": "user", "content": f"q {i}"},
                                      {"role": "assistant", "content": f"a {i}"})]
        with self.assertRaises(RequestError) as error:
            await self.prompt(state, raw)
        self.assertEqual(str(error.exception), "Hermes model call failed: invalid_request (HTTP 400)")
        # 主模型恰好两次（原始 + 清洗后一次重试），不是三次，也没换到备用模型。
        self.assertEqual(calls, ["magpie-model", "magpie-model"])
        self.assertLess(sizes[1], sizes[0])
        # 下一轮照样先试主模型——断路器没有开。
        calls.clear()
        state.agent.run_hook = lambda agent, user, history: (calls.append(agent.model),
            {"messages": history, "final_response": "ok"})[1]
        raw2 = payload()
        raw2["scope"]["runId"] = "run-2"
        response = await self.prompt(state, raw2)
        self.assertEqual(calls, ["magpie-model"])
        self.assertEqual(response.stop_reason, "end_turn")

    async def test_400_cleanup_retry_under_deadline_succeeds_without_breaker(self):
        # QA1102-14 + QA1102-06：首字时限包着 execute()——被拒请求的清洗重试是一次新的
        # 尝试，拿自己的时限窗口而不是吃被拒调用剩下的配额；400 本身永不进断路器。
        import chisabot_acp
        calls = []
        self.addCleanup(chisabot_acp.reset_model_breakers)
        state = await self.new()

        class BadRequest(Exception):
            status_code = 400

        def hook(agent, user, history):
            calls.append(agent.model)
            # 两次主模型调用各自快于时限，但加起来超出一个窗口：没有重新武装的话
            # 第二次会在时限处被掐断、主模型被误开断路器并换到备用模型。
            time.sleep(0.06)
            if len(calls) == 1:
                raise BadRequest("Invalid input")
            agent.stream_delta_callback("answer")
            return {"messages": history + [{"role": "user", "content": user},
                                           {"role": "assistant", "content": "answer"}],
                    "final_response": "answer"}

        state.agent.run_hook = hook
        raw = payload()
        raw["model"]["fallbacks"] = ["backup-a"]
        with patch.dict(os.environ, {"CHISABOT_FIRST_TOKEN_TIMEOUT_S": "0.1"}):
            response = await self.prompt(state, raw)
        self.assertEqual(calls, ["magpie-model", "magpie-model"])
        self.assertEqual(response.stop_reason, "end_turn")
        self.assertIsNone(response.field_meta)
        self.assertNotIn(("custom", "https://magpie.invalid/v1", "magpie-model"),
                         chisabot_acp._MODEL_BREAKERS)
        # 下一轮仍先拨主模型——400 没有让断路器打开。
        calls.clear()
        state.agent.run_hook = lambda agent, user, history: (calls.append(agent.model),
            {"messages": history, "final_response": "ok"})[1]
        raw2 = payload()
        raw2["scope"]["runId"] = "run-2"
        response = await self.prompt(state, raw2)
        self.assertEqual(calls, ["magpie-model"])
        self.assertIsNone(response.field_meta)

    async def test_rejected_switch_is_reported_but_does_not_cool_the_primary(self):
        # QA1102-14：Hermes 因 400（context_overflow）换了模型——记录 + 上报原因，
        # 但不冷却主模型，下一轮主模型照用。
        import chisabot_acp
        self.addCleanup(chisabot_acp.reset_model_breakers)
        chains = []
        with patch.dict(sys.modules, self.model_control_modules(chains)):
            await self.adapter.initialize()
            state = await self.new()
            calls = []
            def walk(agent, reason=None, reset_at=None):
                if agent._fallback_index >= len(agent._fallback_chain):
                    return False
                agent.model = agent._fallback_chain[agent._fallback_index]["model"]
                agent._fallback_index += 1
                return True
            state.agent._try_activate_fallback = lambda reason=None, reset_at=None: walk(state.agent, reason, reset_at)
            def hook(agent, user, history):
                calls.append(agent.model)
                if agent.model == "magpie-model":
                    agent._try_activate_fallback(reason=SimpleNamespace(value="context_overflow"))
                    calls.append(agent.model)
                return {"messages": history + [{"role": "user", "content": user},
                                               {"role": "assistant", "content": "ok"}], "final_response": "ok"}
            state.agent.run_hook = hook
            raw = payload()
            raw["model"]["fallbacks"] = ["backup-a"]
            response = await self.prompt(state, raw)
            self.assertEqual(response.field_meta["chisabot"]["modelFallback"],
                             {"from": "magpie-model", "to": "backup-a", "reason": "rejected"})
            self.assertEqual(calls, ["magpie-model", "backup-a"])
            calls.clear()
            state.agent.run_hook = lambda agent, user, history: (calls.append(agent.model),
                {"messages": history, "final_response": "ok"})[1]
            raw2 = payload()
            raw2["scope"]["runId"] = "run-2"
            raw2["model"]["fallbacks"] = ["backup-a"]
            response = await self.prompt(state, raw2)
            self.assertEqual(calls, ["magpie-model"])
            self.assertIsNone(response.field_meta)

    def rebuilding_agent_switch(self):
        """QA1102-13 r1：和 QA 的 rebuilding fake 一样——换模型像真实 _make_agent 那样
        重建 state.agent，但保留 run_hook / provider / base_url，让行为脚本继续生效。
        配置走 set_session_model（异步），轮中重试走 _switch_model（同步，QA1104-02），
        两条路都要重建。"""
        server_mod = self.modules["acp_adapter.server"]

        def rebuild(agent_self, target, model_id):
            agent_self.switches.append(model_id)
            old = target.agent
            fresh = FakeAgent()  # tools=[] / valid_tool_names=∅ / callbacks=None / system=None
            fresh.run_hook = old.run_hook
            fresh.provider, fresh.base_url = old.provider, old.base_url
            fresh.model = model_id
            target.agent = fresh
            target.model = model_id

        async def replacing(agent_self, model_id, session_id, **kwargs):
            rebuild(agent_self, agent_self.session_manager.get_session(session_id), model_id)
            return Model()

        def replacing_sync(agent_self, state, raw_model, *, keep_endpoint=False):
            rebuild(agent_self, state, raw_model)
            return ("custom", "custom", raw_model)

        @contextmanager
        def both():
            with patch.object(server_mod.HermesACPAgent, "set_session_model", replacing), \
                 patch.object(server_mod.HermesACPAgent, "_switch_model", replacing_sync):
                yield

        return both()

    async def test_breaker_skip_turn_rebinds_rebuilt_agent(self):
        # QA1102-13 r1：断路器跳过主模型那一轮——备用模型那次请求也必须带工具和系统提示词，
        # 哪怕 set_session_model 把整个 agent 换了一个对象。
        import chisabot_acp
        self.addCleanup(chisabot_acp.reset_model_breakers)
        state = await self.new()
        chisabot_acp.breaker_fail(("custom", "https://magpie.invalid/v1", "magpie-model"),
                                "unavailable", chisabot_acp._now())
        raw = payload()
        raw["model"]["fallbacks"] = ["backup-a"]
        with self.rebuilding_agent_switch():
            response = await self.prompt(state, raw)
        live = state.agent
        self.assertEqual(live.model, "backup-a")
        self.assertEqual(len(live.inputs), 1)
        inputs = live.inputs[0]
        self.assertEqual([t["function"]["name"] for t in inputs["tools"]], ["device_list"])
        self.assertEqual(inputs["system"], "Host identity")
        self.assertEqual(response.stop_reason, "end_turn")
        self.assertEqual(response.field_meta["chisabot"]["modelFallback"],
                         {"from": "magpie-model", "to": "backup-a", "reason": "unavailable"})

    async def test_first_token_timeout_fallback_rebinds_rebuilt_agent(self):
        # QA1102-13 r1：首 token 超时后同轮换备用——_retry_turn_model 也要把工具面 /
        # 系统提示词 / 回调绑到重建后的活 agent 上（旧实现全部写进了被丢弃的旧对象）。
        import chisabot_acp
        calls = []
        down = {"magpie-model": True}
        self.addCleanup(chisabot_acp.reset_model_breakers)
        state = await self.new()
        state.agent.run_hook = self.hanging_turn(down, calls)
        raw = payload()
        raw["model"]["fallbacks"] = ["backup-a"]
        with self.rebuilding_agent_switch():
            with patch.dict(os.environ, {"CHISABOT_FIRST_TOKEN_TIMEOUT_S": "0.3"}):
                response = await self.prompt(state, raw)
        self.assertEqual(calls, ["magpie-model", "backup-a"])
        live = state.agent
        self.assertEqual(live.model, "backup-a")
        inputs = live.inputs[-1]
        self.assertEqual([t["function"]["name"] for t in inputs["tools"]], ["device_list"])
        self.assertEqual(inputs["system"], "Host identity")
        self.assertEqual(response.stop_reason, "end_turn")
        self.assertEqual(response.field_meta["chisabot"]["modelFallback"],
                         {"from": "magpie-model", "to": "backup-a", "reason": "unavailable"})
        # 流式回调也接回了新 agent：备用那句回答是流出来的，不只靠末尾补发。
        self.assertTrue(any(e[0] == "acp" and e[2].session_update == "agent_message_chunk"
                            for e in self.events))

    def test_context_floor_raises_underreported_window(self):
        # QA1104-01：目录声明的窗口抬过端点探测的误报——swe-2 的 /api/show 报 32K，
        # 低于 Hermes 64K 下限会让 configure/turn 双双被拒；三处都按目录值抬，
        # 更大的探测值（1M 模型）不被压低，备用应用的轮次不被主模型窗口污染。
        import chisabot_acp
        from chisabot_protocol import parse_host_prompt
        raw = payload()
        raw["model"]["contextWindow"] = 262144
        config = parse_host_prompt(raw)

        class Compressor:
            def __init__(self, ctx):
                self.context_length = ctx
            def update_model(self, model, context_length, **kw):
                self.model, self.context_length = model, context_length

        agent = SimpleNamespace(model="magpie-model", provider="custom", api_key="",
                                api_mode="chat", base_url="https://magpie.invalid/v1",
                                context_compressor=Compressor(32768),
                                _config_context_length=None, _ollama_num_ctx=32768)
        chisabot_acp.apply_context_floor(agent, config, applied="magpie-model")
        self.assertEqual(agent.context_compressor.context_length, 262144)
        self.assertEqual(agent._config_context_length, 262144)
        self.assertEqual(agent._ollama_num_ctx, 262144)

        bigger = SimpleNamespace(model="magpie-model", context_compressor=Compressor(1_000_000),
                                 _config_context_length=None, _ollama_num_ctx=None)
        chisabot_acp.apply_context_floor(bigger, config, applied="magpie-model")
        self.assertEqual(bigger.context_compressor.context_length, 1_000_000)
        self.assertIsNone(bigger._ollama_num_ctx)  # 未设置的远端端点不补 num_ctx

        other = SimpleNamespace(model="backup-a", context_compressor=Compressor(32768),
                                _config_context_length=None, _ollama_num_ctx=32768)
        chisabot_acp.apply_context_floor(other, config, applied="backup-a")
        self.assertEqual(other.context_compressor.context_length, 32768)
        self.assertEqual(other._ollama_num_ctx, 32768)

    def replace_agent_on_switch(self):
        """QA1102-13：原生换模型路径会重建 state.agent（_switch_model → _make_agent），
        不是只改 model 字段。返回一个替换用的 set_session_model。"""
        server_mod = self.modules["acp_adapter.server"]

        async def replacing(agent_self, model_id, session_id, **kwargs):
            agent_self.switches.append(model_id)
            target = agent_self.session_manager.get_session(session_id)
            fresh = FakeAgent()  # tools=[] / valid_tool_names=∅ / ephemeral_system_prompt=None
            fresh.model = model_id
            target.agent = fresh
            target.model = model_id
            return Model()

        return patch.object(server_mod.HermesACPAgent, "set_session_model", replacing)

    async def test_model_switch_rebuilds_agent_and_configure_lands_on_the_live_one(self):
        # 4b323956 的回归：切换后 restrict / 工具 / 系统提示词写进了被丢弃的旧 agent。
        state = await self.new()
        old_agent = state.agent
        with self.replace_agent_on_switch():
            response = await self.prompt(state)
        live = state.agent
        self.assertIsNot(live, old_agent)
        self.assertEqual(live.model, "magpie-model")
        self.assertEqual(live.valid_tool_names, {"device_list"})
        self.assertEqual([t["function"]["name"] for t in live.tools], ["device_list"])
        self.assertEqual(live.inputs[0]["system"], "Host identity")
        self.assertEqual(live.inputs[0]["tools"][0]["function"]["name"], "device_list")
        self.assertIsNone(live.ephemeral_system_prompt)  # 轮末清掉，configure 每轮重设
        self.assertFalse(old_agent.inputs)
        self.assertEqual(response.stop_reason, "end_turn")
        # 同一 agent 下一轮（不再切换）仍然拿到完整系统提示词与工具——每一轮都在配置。
        raw = payload()
        raw["scope"]["runId"] = "run-2"
        await self.prompt(state, raw)
        self.assertIs(state.agent, live)
        self.assertEqual(live.inputs[1]["system"], "Host identity")
        self.assertEqual(live.inputs[1]["tools"][0]["function"]["name"], "device_list")

    async def test_live_agent_without_host_tools_fails_loud(self):
        # 防御断言：config.tools 非空而活 agent 上没有任何可调工具 → ProtocolError。
        state = await self.new()
        server_mod = self.modules["acp_adapter.server"]

        class DeafAgent(FakeAgent):
            @property
            def valid_tool_names(self):
                return set()

            @valid_tool_names.setter
            def valid_tool_names(self, value):
                pass

        async def replacing(agent_self, model_id, session_id, **kwargs):
            target = agent_self.session_manager.get_session(session_id)
            fresh = DeafAgent()
            fresh.model = model_id
            target.agent = fresh
            return Model()

        with patch.object(server_mod.HermesACPAgent, "set_session_model", replacing):
            with self.assertRaises(RequestError) as error:
                await self.prompt(state)
        self.assertEqual(error.exception.code, -32602)
        self.assertFalse(state.agent.inputs)
        self.assertFalse(any(e[0] == "http" for e in self.events))

    async def test_promise_only_answer_gets_exactly_one_tool_step_nudge(self):
        # QA1102-13：只承诺「我去查」却一个工具都没调 → 催一步；只催一步。
        state = await self.new()
        calls = []

        def hook(agent, user, history):
            calls.append(user)
            if len(calls) > 1:
                agent.tool_start_callback("call-9", "device_list", {"limit": 1})
                token = self.call_id.set("call-9")
                try:
                    result = self.registry.get_entry("device_list").handler({"limit": 1})
                finally:
                    self.call_id.reset(token)
                agent.tool_complete_callback("call-9", "device_list", {"limit": 1}, result)
                return {"messages": history + [{"role": "user", "content": user},
                                               {"role": "assistant", "content": "查到了"}], "final_response": "查到了"}
            return {"messages": history + [{"role": "user", "content": user},
                                           {"role": "assistant", "content": "我先去查一下再回答你"}],
                    "final_response": "我先去查一下再回答你"}

        state.agent.run_hook = hook
        response = await self.prompt(state)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], "Current user")
        self.assertIn("现在就调用工具", calls[1])
        self.assertEqual(sum(e[0] == "http" for e in self.events), 1)
        self.assertEqual(response.stop_reason, "end_turn")

        calls.clear()
        state.agent.run_hook = lambda agent, user, history: (calls.append(user),
            {"messages": history, "final_response": "我再去查"})[1]
        raw = payload()
        raw["scope"]["runId"] = "run-2"
        await self.prompt(state, raw)
        self.assertEqual(len(calls), 2)  # 催过之后无论说什么都收尾，不无限续步。

        calls.clear()

        def with_tool(agent, user, history):
            calls.append(user)
            agent.tool_start_callback("call-7", "device_list", {})
            token = self.call_id.set("call-7")
            try:
                result = self.registry.get_entry("device_list").handler({})
            finally:
                self.call_id.reset(token)
            agent.tool_complete_callback("call-7", "device_list", {}, result)
            return {"messages": history, "final_response": "我先去查一下再回答你"}

        state.agent.run_hook = with_tool
        raw["scope"]["runId"] = "run-3"
        await self.prompt(state, raw)
        self.assertEqual(len(calls), 1)  # 本轮已经调过工具：承诺话术不再催。

    async def test_promise_guard_is_future_tense_only(self):
        # QA1102-13 r1：「我下载好了」「我找到了」是已完成不是承诺；「我马上处理」才是。
        state = await self.new()
        calls = []
        def answering(text):
            return lambda agent, user, history: (calls.append(user),
                {"messages": history, "final_response": text})[1]
        for run_id, text, want_calls in (
                ("run-1", "我下载好了", 1), ("run-2", "我找到了接入文档", 1),
                ("run-3", "我马上处理", 2)):
            calls.clear()
            state.agent.run_hook = answering(text)
            raw = payload()
            raw["scope"]["runId"] = run_id
            await self.prompt(state, raw)
            self.assertEqual(len(calls), want_calls, text)
        # 这一轮宿主没给工具：承诺话术也不催。
        calls.clear()
        state.agent.run_hook = answering("我马上处理")
        raw = payload()
        raw["scope"]["runId"] = "run-4"
        raw["tools"] = []
        await self.prompt(state, raw)
        self.assertEqual(len(calls), 1)

    async def test_fresh_session_first_turn_carries_tools_and_system_prompt(self):
        # 新会话首轮就是一次模型切换：短对话请求里必须有 tools 和系统提示词。
        state = await self.new()
        with self.replace_agent_on_switch():
            await self.prompt(state)
        inputs = state.agent.inputs[0]
        self.assertEqual(inputs["system"], "Host identity")
        self.assertEqual([t["function"]["name"] for t in inputs["tools"]], ["device_list"])
        self.assertEqual(inputs["history"], payload()["history"])
        self.assertEqual(state.agent.valid_tool_names, {"device_list"})

    async def test_consecutive_user_rows_merge_into_one(self):
        # QA1102-13：失败轮次只留下连续 user 行（交替违规），发送时合并。
        state = await self.new()
        raw = payload()
        raw["history"] = [{"role": "user", "content": "one"}, {"role": "user", "content": "two"},
                          {"role": "assistant", "content": "answer"}, {"role": "user", "content": "three"}]
        await self.prompt(state, raw)
        history = state.agent.inputs[0]["history"]
        self.assertEqual(history[0], {"role": "user", "content": "one\n\ntwo"})
        self.assertEqual(history[1]["content"], "answer")
        self.assertEqual(history[2]["content"], "three")
        self.assertEqual(len(history), 3)


if __name__ == "__main__":
    unittest.main()
