"""Standard-library-only ChisaBot host-tool protocol and HTTP boundary.

This module deliberately imports neither Hermes nor ACP. Credentials live in a
per-turn RunState; tool schemas, prompt text and conversation history never
receive the gateway envelope.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
import threading
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

PROTOCOL_VERSION = 1
_TOOL_NAME = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
_MAX_RESPONSE_BYTES = 8 * 1024 * 1024


class ProtocolError(ValueError):
    """A safe, field-oriented validation error; never includes supplied values."""


def _json_copy(value: Any, label: str) -> Any:
    try:
        return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError, RecursionError):
        raise ProtocolError(f"{label} must contain JSON values") from None


def _text(value: Any, label: str, *, empty: bool = False) -> str:
    if not isinstance(value, str) or (not empty and not value.strip()):
        raise ProtocolError(f"{label} must be a {'non-empty ' if not empty else ''}string")
    return value


@dataclass(frozen=True)
class Scope:
    actor_id: str
    bot_id: str
    thread_id: str
    run_id: str

    @property
    def session_key(self) -> tuple[str, str, str]:
        return self.actor_id, self.bot_id, self.thread_id


@dataclass(frozen=True)
class HostTool:
    name: str
    description: str
    input_schema: dict[str, Any]

    def registry_schema(self) -> dict[str, Any]:
        return {"name": self.name, "description": self.description,
                "parameters": copy.deepcopy(self.input_schema)}


@dataclass(frozen=True)
class Gateway:
    url: str = field(repr=False)
    capability: str = field(repr=False)


@dataclass(frozen=True)
class HostPrompt:
    scope: Scope
    system_prompt: str = field(repr=False)
    history: list[dict[str, Any]] = field(repr=False)
    tools: tuple[HostTool, ...]
    gateway: Gateway = field(repr=False)
    model_id: str
    continuation: bool = False
    current_message: dict[str, Any] | None = field(default=None, repr=False)


@dataclass(frozen=True)
class ToolAliases:
    """Private Hermes names; every host-facing identity remains canonical."""

    to_internal: dict[str, str]
    to_canonical: dict[str, str]

    @classmethod
    def for_prompt(cls, config: HostPrompt, reserved: set[str]) -> "ToolAliases":
        names = {tool.name for tool in config.tools}
        for message in config.history:
            if message.get("role") == "assistant":
                for call in message.get("tool_calls") or []:
                    function = call.get("function") if isinstance(call, dict) else None
                    if isinstance(function, dict) and isinstance(function.get("name"), str):
                        names.add(function["name"])
            elif message.get("role") == "tool":
                for field_name in ("name", "tool_name"):
                    if isinstance(message.get(field_name), str):
                        names.add(message[field_name])
        forward, reverse = {}, {}
        for name in sorted(names):
            if name not in reserved and not name.startswith("connectors__"):
                continue
            alias = "chisabot_host_" + name
            if len(alias) > 64:
                alias = "chisabot_host_" + hashlib.sha256(name.encode("utf-8")).hexdigest()[:32]
            if alias in names or alias in reverse or alias in reserved:
                raise ProtocolError("A private Hermes tool alias collides with another host or reserved tool name")
            forward[name], reverse[alias] = alias, name
        return cls(forward, reverse)

    def internal(self, name: str) -> str:
        return self.to_internal.get(name, name)

    def canonical(self, name: str) -> str:
        return self.to_canonical.get(name, name)

    def text(self, text: str | None, *, canonical: bool = False) -> str | None:
        mapping = self.to_canonical if canonical else self.to_internal
        if not text or not mapping:
            return text
        # One substitution pass prevents alias chains. JSON argument strings and
        # message bodies never go through this function during history mapping.
        names = "|".join(re.escape(name) for name in sorted(mapping, key=lambda name: (-len(name), name)))
        pattern = r"(?<![A-Za-z0-9_-])(?:" + names + r")(?![A-Za-z0-9_-])"
        return re.sub(pattern, lambda match: mapping[match.group(0)], text)

    def history(self, messages: list[dict[str, Any]], *, canonical: bool = False) -> list[dict[str, Any]]:
        result = copy.deepcopy(messages)
        translate = self.canonical if canonical else self.internal
        for message in result:
            if message.get("role") == "assistant":
                for call in message.get("tool_calls") or []:
                    function = call.get("function") if isinstance(call, dict) else None
                    if isinstance(function, dict) and isinstance(function.get("name"), str):
                        function["name"] = translate(function["name"])
            elif message.get("role") == "tool":
                for field_name in ("name", "tool_name"):
                    if isinstance(message.get(field_name), str):
                        message[field_name] = translate(message[field_name])
        return result


def host_metadata(kwargs: Mapping[str, Any], *, required: bool = True) -> Any:
    """ACP's router flattens _meta into kwargs; direct Python callers may not."""
    candidates = []
    if "chisabot" in kwargs:
        candidates.append(kwargs["chisabot"])
    for key in ("_meta", "field_meta"):
        envelope = kwargs.get(key)
        if isinstance(envelope, dict) and "chisabot" in envelope:
            candidates.append(envelope["chisabot"])
    if len(candidates) > 1:
        raise ProtocolError("Provide _meta.chisabot exactly once")
    if candidates:
        return candidates[0]
    if required:
        raise ProtocolError("Missing required _meta.chisabot host-tools protocol")
    return None


def _history(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ProtocolError("chisabot.history must be an OpenAI message array")
    messages = []
    for item in value:
        if not isinstance(item, dict) or item.get("role") not in {"user", "assistant", "tool"}:
            raise ProtocolError("history roles must be user, assistant or tool; use systemPrompt for system content")
        # Transport/UI metadata must never become model-visible context.
        message = {k: _json_copy(v, "history message") for k, v in item.items()
                   if k in {"role", "content", "name", "tool_name", "tool_calls", "tool_call_id",
                            "reasoning_content", "reasoning", "refusal"}}
        content = message.get("content")
        if content is not None and not isinstance(content, (str, list)):
            raise ProtocolError("history message content must be text, blocks or null")
        if "name" in message:
            _text(message["name"], "history message name")
        if item["role"] == "tool":
            _text(message.get("tool_call_id"), "history tool_call_id")
        if "tool_calls" in message:
            if item["role"] != "assistant" or not isinstance(message["tool_calls"], list):
                raise ProtocolError("history tool_calls must be an assistant tool-call array")
            calls = []
            for call in message["tool_calls"]:
                if not isinstance(call, dict) or call.get("type", "function") != "function":
                    raise ProtocolError("history tool_calls must use OpenAI function calls")
                call_id = _text(call.get("id"), "history tool call id")
                function = call.get("function")
                if not isinstance(function, dict):
                    raise ProtocolError("history tool call function must be an object")
                name = _text(function.get("name"), "history tool function name")
                arguments = _text(function.get("arguments"), "history tool function arguments", empty=True)
                calls.append({"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}})
            message["tool_calls"] = calls
        messages.append(message)
    return messages


def parse_host_prompt(value: Any) -> HostPrompt:
    if not isinstance(value, dict):
        raise ProtocolError("_meta.chisabot must be an object")
    if type(value.get("version")) is not int or value["version"] != PROTOCOL_VERSION:
        raise ProtocolError("_meta.chisabot.version must be 1")
    raw_scope = value.get("scope")
    if not isinstance(raw_scope, dict):
        raise ProtocolError("chisabot.scope must be an object")
    scope = Scope(*(_text(raw_scope.get(k), f"chisabot.scope.{k}")
                    for k in ("actorId", "botId", "threadId", "runId")))
    system = _text(value.get("systemPrompt"), "chisabot.systemPrompt", empty=True)
    history = _history(value.get("history"))
    raw_tools = value.get("tools")
    if not isinstance(raw_tools, list):
        raise ProtocolError("chisabot.tools must be an array")
    tools, names = [], set()
    for raw in raw_tools:
        if not isinstance(raw, dict):
            raise ProtocolError("chisabot.tools entries must be objects")
        name = _text(raw.get("name"), "tool name")
        if not _TOOL_NAME.fullmatch(name):
            raise ProtocolError("tool names must contain 1-128 ASCII letters, digits, underscores or hyphens")
        if name in names:
            raise ProtocolError("chisabot.tools contains a duplicate name")
        names.add(name)
        description = _text(raw.get("description"), "tool description", empty=True)
        schema = _json_copy(raw.get("inputSchema"), "tool inputSchema")
        if not isinstance(schema, dict) or schema.get("type", "object") != "object":
            raise ProtocolError("tool inputSchema must be an object JSON Schema")
        if "properties" in schema and not isinstance(schema["properties"], dict):
            raise ProtocolError("tool inputSchema.properties must be an object")
        if "required" in schema and (not isinstance(schema["required"], list)
                                     or any(not isinstance(k, str) for k in schema["required"])):
            raise ProtocolError("tool inputSchema.required must be a string array")
        tools.append(HostTool(name, description, schema))
    raw_gateway = value.get("toolGateway")
    if not isinstance(raw_gateway, dict):
        raise ProtocolError("chisabot.toolGateway must be an object")
    url = _text(raw_gateway.get("url"), "toolGateway.url")
    try:
        parsed = urlsplit(url)
        valid_url = (parsed.scheme in {"http", "https"} and parsed.hostname and parsed.port != 0
                     and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
                     and not any(c.isspace() for c in url))
    except ValueError:
        valid_url = False
    if not valid_url:
        raise ProtocolError("toolGateway.url must be an absolute HTTP(S) URL without credentials, query or fragment")
    capability = _text(raw_gateway.get("capability"), "toolGateway.capability")
    if not capability.isascii() or any(c.isspace() or ord(c) < 33 or ord(c) == 127 for c in capability):
        raise ProtocolError("toolGateway.capability must be an ASCII bearer token without whitespace")
    raw_model = value.get("model")
    if not isinstance(raw_model, dict):
        raise ProtocolError("chisabot.model must be an object")
    model_id = _text(raw_model.get("id"), "chisabot.model.id")
    continuation = value.get("continuation", False)
    if type(continuation) is not bool:
        raise ProtocolError("chisabot.continuation must be a boolean")
    current = value.get("currentMessage")
    if current is not None:
        if not isinstance(current, dict) or current.get("role") != "user":
            raise ProtocolError("chisabot.currentMessage must be an OpenAI user message")
        current = _history([current])[0]
        if current.get("content") is None:
            raise ProtocolError("chisabot.currentMessage must contain user content")
    # Refuse a transport capability accidentally copied into a model-visible field.
    model_visible = json.dumps([system, history, current, [tool.registry_schema() for tool in tools], model_id], ensure_ascii=False)
    if capability in model_visible:
        raise ProtocolError("The gateway capability must not occur in model-visible content")
    return HostPrompt(scope, system, history, tuple(tools), Gateway(url.rstrip("/"), capability), model_id, continuation, current)


def redact(value: Any, secret: str) -> Any:
    if isinstance(value, str):
        return value.replace(secret, "[REDACTED]") if secret else value
    if isinstance(value, list):
        return [redact(v, secret) for v in value]
    if isinstance(value, dict):
        return {redact(k, secret): redact(v, secret) for k, v in value.items()}
    return value


class GatewayError(Exception):
    def __init__(self, code: str, message: str, *, definitive: bool = False):
        super().__init__(message)
        self.code, self.message, self.definitive = code, message, definitive


class ToolSuspended(Exception):
    def __init__(self, waiting: dict[str, Any]):
        super().__init__("The host tool is waiting for continuation")
        self.waiting = waiting


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Do not forward a run capability to another endpoint, even on same-host redirects.
        return None


class GatewayClient:
    """One POST, no retry or redirect; inject transport for socket-free tests."""

    def __init__(self, gateway: Gateway, *, transport: Callable[..., Any] | None = None, timeout: float = 15 * 60 + 10):
        self.gateway, self.timeout = gateway, timeout
        self._transport = transport or build_opener(ProxyHandler({}), _NoRedirect()).open

    def call(self, call_id: str, name: str, args: dict[str, Any]) -> str:
        body = json.dumps({"callId": call_id, "name": name, "args": args}, ensure_ascii=False, allow_nan=False).encode("utf-8")
        request = Request(self.gateway.url + "/tools/call", data=body, method="POST",
                          headers={"Authorization": "Bearer " + self.gateway.capability,
                                   "Content-Type": "application/json", "Accept": "application/json"})
        try:
            response = self._transport(request, timeout=self.timeout)
        except HTTPError as exc:
            response = exc
        except Exception:
            raise GatewayError("gateway_unavailable", "The host tool gateway could not be reached") from None
        try:
            status = response.getcode()
            raw = response.read(_MAX_RESPONSE_BYTES + 1)
            if len(raw) > _MAX_RESPONSE_BYTES:
                raise GatewayError("gateway_response_too_large", "The host tool gateway response exceeded the size limit")
            try:
                payload = json.loads(raw.decode("utf-8"))
            except (UnicodeError, ValueError):
                raise GatewayError("gateway_invalid_response", "The host tool gateway returned invalid JSON") from None
        except GatewayError:
            raise
        except Exception:
            raise GatewayError("gateway_unavailable", "The host tool gateway response could not be read") from None
        finally:
            try:
                response.close()
            except Exception:
                pass
        error = payload.get("error") if isinstance(payload, dict) else None
        code = error.get("code") if isinstance(error, dict) else error
        if not code and isinstance(payload, dict):
            code = payload.get("code")
        if status == 409 and code == "tool_suspended":
            waiting = payload.get("waiting")
            if not isinstance(waiting, dict):
                raise GatewayError("gateway_invalid_suspension", "The host tool gateway omitted waiting metadata")
            raise ToolSuspended(redact(waiting, self.gateway.capability))
        if not isinstance(status, int) or not 200 <= status < 300:
            # Upstream messages/exception strings may echo bearer tokens or request bodies.
            safe_codes = {"invalid_capability", "unknown_tool", "invalid_arguments", "invalid_call",
                          "call_conflict", "run_closed", "run_aborted", "tool_failed"}
            safe_code = code if isinstance(code, str) and code in safe_codes else "gateway_http_error"
            definitive = (status == 400 and safe_code in {"invalid_arguments", "invalid_call"}
                          or status == 404 and safe_code == "unknown_tool")
            raise GatewayError(safe_code, f"The host tool gateway rejected the call (HTTP {status})",
                               definitive=definitive)
        if not isinstance(payload, dict) or "result" not in payload or payload.get("ok") is False or error:
            raise GatewayError("gateway_invalid_response", "The host tool gateway omitted a successful result")
        result = payload["result"]
        text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, allow_nan=False)
        return redact(text, self.gateway.capability)


def tool_error(code: str, message: str) -> str:
    return json.dumps({"ok": False, "error": {"code": code, "message": message}}, ensure_ascii=False)


@dataclass
class ToolRecord:
    name: str
    args: dict[str, Any]
    acknowledged: bool = False
    completed: bool = False


@dataclass
class RunState:
    session_id: str
    config: HostPrompt = field(repr=False)
    interrupt: Callable[[], Any] = field(repr=False)
    client: GatewayClient = field(repr=False)
    pending_suspension: dict[str, Any] | None = None
    fatal_error: str | None = None
    closed: bool = False
    records: dict[str, ToolRecord] = field(default_factory=dict, repr=False)
    lock: Any = field(default_factory=threading.RLock, repr=False)
    dispatch_lock: Any = field(default_factory=threading.Lock, repr=False)

    def fail(self, reason: str) -> None:
        with self.lock:
            self.fatal_error = self.fatal_error or reason
        self._interrupt()

    def _interrupt(self) -> None:
        try:
            self.interrupt()
        except Exception:
            # A broken interrupt API still closes the HTTP and streaming gates.
            with self.lock:
                self.fatal_error = self.fatal_error or "Hermes could not interrupt the host-tool turn"

    def start(self, call_id: str, name: str, args: dict[str, Any], emit: Callable[[], None]) -> None:
        with self.lock:
            if self.closed or self.pending_suspension or self.fatal_error:
                return
            if not isinstance(call_id, str) or not call_id or name not in {t.name for t in self.config.tools}:
                self.fail("Hermes emitted an invalid host tool start")
                return
            if call_id in self.records:
                self.fail("Hermes emitted a duplicate host tool call ID")
                return
            self.records[call_id] = ToolRecord(name, redact(copy.deepcopy(args), self.config.gateway.capability))
        try:
            emit()  # Must settle successfully before the HTTP caller is authorized.
        except Exception:
            self.fail("ACP tool start could not be delivered")
            return
        with self.lock:
            self.records[call_id].acknowledged = True

    def execute(self, call_id: str, name: str, args: dict[str, Any]) -> str:
        # Serialize host HTTP calls even when Hermes schedules a parallel batch.
        # Waiting workers re-check the latch after the preceding HTTP result.
        with self.dispatch_lock:
            with self.lock:
                if self.pending_suspension:
                    return tool_error("tool_suspended", "The host turn is suspended; no additional tool was executed")
                if self.closed or self.fatal_error:
                    return tool_error("run_closed", "The host-tool turn is closed")
                record = self.records.get(call_id)
                if not record or record.name != name or not record.acknowledged:
                    self.fail("Host tool execution lacked an acknowledged canonical tool start")
                    return tool_error("tool_start_required", "An acknowledged canonical tool start is required")
            try:
                return self.client.call(call_id, name, args)
            except ToolSuspended as exc:
                with self.lock:
                    self.pending_suspension = {"version": PROTOCOL_VERSION, "callId": call_id, "name": name,
                                               "waiting": exc.waiting}
                self._interrupt()
                # The waiting object is transport metadata, never a tool result for the model.
                return tool_error("tool_suspended", "The host turn is suspended for continuation")
            except GatewayError as exc:
                if not exc.definitive:
                    # A lost/malformed/5xx response cannot prove whether the host
                    # already performed a side effect. Stop instead of letting
                    # the model create a fresh call ID and duplicate execution.
                    self.fail("The host gateway outcome is unknown or the run is no longer authorized")
                return tool_error(exc.code, exc.message)
            except Exception:
                self.fail("The host gateway outcome is unknown")
                return tool_error("gateway_error", "The host tool gateway call failed")

    def response_meta(self) -> dict[str, Any] | None:
        with self.lock:
            return copy.deepcopy(self.pending_suspension)

    def close(self) -> None:
        with self.lock:
            self.closed = True

    def may_stream(self) -> bool:
        with self.lock:
            return not (self.closed or self.pending_suspension or self.fatal_error)


active_run: ContextVar[RunState | None] = ContextVar("chisabot_host_run", default=None)


# Model-call failures reach the browser only as one of these fixed sentences. Each one is worded
# so the web app's friendly-error rules (app/src/lib/chat/friendly-error.ts) pick the matching
# headline and next step; the provider's own text never leaves this process.
TURN_FAILED = "Hermes host turn execution failed"
_FAILURE_MESSAGES = {
    "rate_limit": "Hermes model call failed: rate_limit (HTTP 429)",
    "quota": "Hermes model call failed: quota exhausted (HTTP 402)",
    "auth": "Hermes model call failed: unauthorized (HTTP 401)",
    "context_length": "Hermes model call failed: context_length exceeded",
    "timeout": "Hermes model call failed: timeout",
    "provider_unavailable": "Hermes model call failed: service unavailable (HTTP 503)",
    "model_not_found": "Hermes model call failed: model not found (HTTP 404)",
    "content_filter": "Hermes model call failed: content_filter",
    "stream": "Hermes model call failed: stream error",
}
# Hermes' FailoverReason values (agent/error_classifier.py) folded into the categories above.
_REASONS = {
    "rate_limit": "rate_limit", "upstream_rate_limit": "rate_limit",
    "billing": "quota",
    "auth": "auth", "auth_permanent": "auth", "model_entitlement": "auth",
    "context_overflow": "context_length", "payload_too_large": "context_length", "long_context_tier": "context_length",
    "timeout": "timeout",
    "overloaded": "provider_unavailable", "server_error": "provider_unavailable", "upstream_blocked": "provider_unavailable",
    "model_not_found": "model_not_found",
    "content_policy_blocked": "content_filter", "provider_policy_blocked": "content_filter",
    "incomplete_response": "stream",
}
_STATUS = {401: "auth", 403: "auth", 402: "quota", 404: "model_not_found", 408: "timeout", 413: "context_length",
           429: "rate_limit"}
_HINTS = (
    ("context_length", re.compile(r"context[_ ]?(length|window)|maximum context|too many tokens|prompt is too long", re.I)),
    ("rate_limit", re.compile(r"rate[_ ]?limit|too many requests", re.I)),
    ("quota", re.compile(r"insufficient[_ ]?quota|billing|credit balance", re.I)),
    ("timeout", re.compile(r"timed?[_ ]?out", re.I)),
    ("auth", re.compile(r"authentication|unauthori[sz]ed|permission[_ ]?denied|invalid[_ ]?api[_ ]?key", re.I)),
    ("model_not_found", re.compile(r"notfound|model[_ ]not[_ ]found", re.I)),
    ("content_filter", re.compile(r"content[_ ]?(filter|policy)", re.I)),
    ("provider_unavailable", re.compile(r"overloaded|service[_ ]?unavailable|internalserver|bad[_ ]?gateway", re.I)),
)


def failure_category(reason: Any = None, error: BaseException | None = None) -> str:
    """Name what went wrong, from Hermes' classified reason or the exception chain; never its text."""
    if isinstance(reason, str) and reason in _REASONS:
        return _REASONS[reason]
    seen = 0
    while error is not None and seen < 5:
        seen += 1
        status = getattr(error, "status_code", None) or getattr(error, "status", None)
        if isinstance(status, int):
            if status in _STATUS:
                return _STATUS[status]
            if 500 <= status < 600:
                return "provider_unavailable"
        code = getattr(error, "code", None)
        clues = " ".join(part for part in (type(error).__name__, code if isinstance(code, str) else "", str(error)) if part)
        for category, pattern in _HINTS:
            if pattern.search(clues):
                return category
        error = error.__cause__ or error.__context__
    return "unknown"


def failure_message(category: str) -> str:
    return _FAILURE_MESSAGES.get(category, TURN_FAILED)
