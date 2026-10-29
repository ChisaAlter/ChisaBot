"""Socket-free contract tests: every Hermes/ACP module below is an explicit fake."""
from __future__ import annotations

import asyncio
import contextvars
import copy
import importlib
import json
from pathlib import Path
import sys
import threading
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
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)

    @classmethod
    def invalid_params(cls, data):
        return cls(-32602, data["details"])


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
        return None

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
            "hermes_cli.config": {"load_config": lambda: {"model": {"default": "magpie-model", "provider": "custom"}}},
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


if __name__ == "__main__":
    unittest.main()
