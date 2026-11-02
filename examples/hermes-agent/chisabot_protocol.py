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
    # ChisaBot's configured backup models (same connection) and output cap for this turn.
    fallbacks: tuple[str, ...] = ()
    max_output_tokens: int | None = None
    # False when ChisaBot already compacted this run's history (trimmed / summarized older turns):
    # Hermes' own context compression stays off for the run so nothing is compressed twice.
    context_compression: bool | None = None
    # Catalog capability flags for this turn's model (QA1102-14): False strips image blocks to
    # text, True keeps standard image_url parts, None means the catalog said nothing (= capable).
    model_images: bool | None = None
    model_files: bool | None = None


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


MAX_FALLBACK_MODELS = 8
MAX_OUTPUT_TOKENS = 1_000_000


def _model_fallbacks(value: Any, primary: str) -> tuple[str, ...]:
    """Ordered backup model ids; the host already applied the admin list / environment rules."""
    if value is None:
        return ()
    if not isinstance(value, list) or len(value) > MAX_FALLBACK_MODELS:
        raise ProtocolError(f"chisabot.model.fallbacks must be an array of at most {MAX_FALLBACK_MODELS} model ids")
    models: list[str] = []
    for raw in value:
        model = _text(raw, "chisabot.model.fallbacks entry")
        if len(model) > 200 or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in model):
            raise ProtocolError("chisabot.model.fallbacks entries must be model ids without whitespace")
        if model != primary and model not in models:
            models.append(model)
    return tuple(models)


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
    fallbacks = _model_fallbacks(raw_model.get("fallbacks"), model_id)
    max_output_tokens = raw_model.get("maxOutputTokens")
    if max_output_tokens is not None and (type(max_output_tokens) is not int
                                          or not 0 < max_output_tokens <= MAX_OUTPUT_TOKENS):
        raise ProtocolError("chisabot.model.maxOutputTokens must be a positive integer")
    context_compression = raw_model.get("contextCompression")
    if context_compression is not None and type(context_compression) is not bool:
        raise ProtocolError("chisabot.model.contextCompression must be a boolean")
    model_images = raw_model.get("supportsImages")
    model_files = raw_model.get("supportsFiles")
    if model_images is not None and type(model_images) is not bool:
        raise ProtocolError("chisabot.model.supportsImages must be a boolean")
    if model_files is not None and type(model_files) is not bool:
        raise ProtocolError("chisabot.model.supportsFiles must be a boolean")
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
    model_visible = json.dumps([system, history, current, [tool.registry_schema() for tool in tools], model_id, fallbacks], ensure_ascii=False)
    if capability in model_visible:
        raise ProtocolError("The gateway capability must not occur in model-visible content")
    return HostPrompt(scope, system, history, tuple(tools), Gateway(url.rstrip("/"), capability), model_id, continuation, current,
                      fallbacks, max_output_tokens, context_compression, model_images, model_files)


"""QA1102-14: normalize history before every OpenAI-compatible request.

生产事故：一段 ~174k token、154 轮工具调用的历史，DeepSeek（OpenAI 兼容端点）每次请求都
回 HTTP 400「Invalid input」，param messages.370.content，主模型被判死、每轮都落在备用
模型上。400 的素材来自历史本身：空 / null content、带不支持块（图片、thinking、
tool_result）的数组 content、没有结果的 tool_calls、没有对应调用的孤儿 tool 消息、
单条几百 KB 的 tool 输出。Hermes 把 ``state.history`` 几乎原样发给端点，所以适配器在
``_configure`` 里先过一遍这个纯函数。

规则：
- 空 / null / 空白 content：带 tool_calls 的 assistant 保留 None（OpenAI 合法形状，
  DeepSeek 自己的回包就长这样），其它一律换成占位文本——裸 ``""`` / ``null`` 就是
  messages.N.content 被判 invalid 的第一种样子；
- 数组 content：只留文本块，图片 / 文件 / 思考 / tool_use 等换成一句占位，
  Anthropic 的 tool_result 块取它里面的文本；
- tool 消息：内容摊平成字符串，超过 ~16k 字符截断并标注——超长 tool 输出是第二种样子；
- assistant 的 tool_calls 没有对应 tool 结果：补一条合成的 tool 消息（第三种样子；
  丢弃调用也行，但留下一条「没返回」的结果模型更看得懂）；
- 孤儿 tool 消息（前面没有匹配的 tool_call，或已应答过）：丢掉。
"""
_EMPTY_CONTENT = "[empty]"
_EMPTY_TOOL_RESULT = "[empty tool result]"
_MISSING_TOOL_RESULT = "[no tool result: the run ended before this call returned]"
_TOOL_OUTPUT_MAX_CHARS = 16_000
_TRUNCATED_NOTE = "...[truncated]"


def _flatten_blocks(content: Any) -> str:
    """数组 content 摊成一段文本：只留文本块，其它块换成占位。"""
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
            continue
        if not isinstance(block, dict):
            continue
        kind = str(block.get("type") or "")
        if kind in {"text", "input_text", "output_text"} and isinstance(block.get("text"), str):
            parts.append(block["text"])
        elif kind == "tool_result":
            inner = block.get("content")
            parts.append(inner if isinstance(inner, str) else _flatten_blocks(inner))
        elif kind in {"image_url", "image", "input_image"}:
            parts.append("[image]")
        elif kind in {"file", "input_file", "input_audio", "audio"}:
            parts.append("[file]")
        elif kind in {"thinking", "reasoning", "redacted_thinking", "reasoning_content"}:
            continue
        elif kind in {"tool_use", "tool_call", "function_call"}:
            parts.append("[tool call]")
        else:
            parts.append(f"[{kind or 'content'}]")
    return "\n".join(part for part in parts if part)


def _content_text(message: dict[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content if content.strip() else ""
    if isinstance(content, list):
        return _flatten_blocks(content)
    return ""


def _normalize_parts(content: list[Any], images: bool | None, files: bool | None) -> list[dict[str, Any]] | None:
    """数组 content 里属于标准 OpenAI 形状的多模态块保留（image_url 按识图能力、file 按收文件能力），
    其余按老规则降级成文本占位。没有多模态块存活时返回 None（调用方收成字符串）。"""
    parts: list[dict[str, Any]] = []
    saw_media = False
    for block in content:
        if isinstance(block, str):
            if block.strip():
                parts.append({"type": "text", "text": block})
            continue
        if not isinstance(block, dict):
            continue
        kind = str(block.get("type") or "")
        if kind == "image_url":
            url = block.get("image_url")
            if images is not False and isinstance(url, dict) and isinstance(url.get("url"), str) and url["url"].strip():
                kept: dict[str, Any] = {"type": "image_url", "image_url": {"url": url["url"]}}
                if isinstance(url.get("detail"), str):
                    kept["image_url"]["detail"] = url["detail"]
                parts.append(kept)
                saw_media = True
            else:
                parts.append({"type": "text", "text": "[image]"})
            continue
        if kind == "file":
            body = block.get("file")
            if files is True and isinstance(body, dict) and (body.get("file_data") or body.get("file_url") or body.get("file_id")):
                parts.append({"type": "file", "file": dict(body)})
                saw_media = True
            else:
                parts.append({"type": "text", "text": "[file]"})
            continue
        flat = _flatten_blocks([block])
        if flat:
            parts.append({"type": "text", "text": flat})
    return parts if saw_media else None


def normalize_content(content: Any, *, images: bool | None = None, files: bool | None = None) -> Any:
    """一条消息 content（字符串 / 块数组）→ 兼容端点收的形状；当前用户消息用（QA1102-14）。"""
    if not isinstance(content, list):
        return content
    parts = _normalize_parts(content, images, files)
    if parts is not None:
        return parts
    return _flatten_blocks(content)


def _merge_content(a: Any, b: Any) -> Any:
    """两条连续同 role 消息的 content 合成一条：摊成块拼接，纯文本收成字符串。"""
    parts: list[Any] = []
    for value in (a, b):
        if isinstance(value, str):
            if value.strip():
                parts.append({"type": "text", "text": value})
        elif isinstance(value, list):
            parts.extend(item for item in value if item is not None)
        elif value is not None:
            parts.append({"type": "text", "text": str(value)})
    if not parts:
        return None
    if all(isinstance(part, dict) and part.get("type") == "text" for part in parts):
        return "\n\n".join(str(part.get("text") or "") for part in parts if str(part.get("text") or "").strip())
    return parts


def normalize_history(messages: Any, *, images: bool | None = None, files: bool | None = None) -> list[dict[str, Any]]:
    """把一段 OpenAI 消息数组改成兼容端点一定收的形状。纯函数，输入不被改动。"""
    if not isinstance(messages, list):
        return []
    normalized: list[dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        row = dict(message)
        role = row.get("role")
        if role == "assistant":
            calls = row.get("tool_calls") if isinstance(row.get("tool_calls"), list) else []
            row["tool_calls"] = [call for call in calls if isinstance(call, dict)]
            text = _content_text(row)
            row["content"] = text if text else (None if row["tool_calls"] else _EMPTY_CONTENT)
        elif role == "tool":
            text = _content_text(row) or _EMPTY_TOOL_RESULT
            row["content"] = (text[:_TOOL_OUTPUT_MAX_CHARS] + _TRUNCATED_NOTE
                              if len(text) > _TOOL_OUTPUT_MAX_CHARS else text)
        elif role == "user":
            parts = _normalize_parts(row["content"], images, files) if isinstance(row.get("content"), list) else None
            row["content"] = parts if parts is not None else (_content_text(row) or _EMPTY_CONTENT)
        else:
            normalized.append(row)
            continue
        normalized.append(row)
    # tool_call / tool 配对：真实结果只在「调用之后、下一条非 tool 消息之前」算数；
    # 没等到的调用在边界处补一条合成结果，孤儿 tool 消息丢掉。
    result: list[dict[str, Any]] = []
    pending: dict[str, bool] = {}
    answered: set[str] = set()

    def flush() -> None:
        for cid in list(pending):
            if cid not in answered:
                answered.add(cid)
                result.append({"role": "tool", "tool_call_id": cid, "content": _MISSING_TOOL_RESULT})
        pending.clear()

    def register(row: dict[str, Any]) -> None:
        for call in row.get("tool_calls") or []:
            cid = call.get("id")
            if isinstance(cid, str) and cid:
                pending[cid] = True

    for row in normalized:
        role = row.get("role")
        if role == "assistant":
            # 上一个 assistant 的调用还没拿到结果：先在它后面补合成结果再开新 assistant——
            # 「assistant(c1), assistant(c2), tool(c1)」这种形状端点同样整单拒。
            flush()
            previous = result[-1] if result else None
            if previous is not None and previous.get("role") == "assistant" and not previous.get("tool_calls"):
                # QA1102-13：连续 assistant 合并成一条（线上历史曾触发 Hermes 修 14 处交替违规）。
                previous["content"] = _merge_content(previous.get("content"), row.get("content"))
                if row.get("tool_calls"):
                    previous["tool_calls"] = list(row["tool_calls"])
                    register(previous)
            else:
                register(row)
                result.append(row)
        elif role == "tool":
            cid = row.get("tool_call_id")
            if cid in pending and cid not in answered:
                answered.add(cid)
                result.append(row)
        else:
            flush()
            previous = result[-1] if result else None
            if role == "user" and previous is not None and previous.get("role") == "user":
                # QA1102-13：连续 user 合并成一条——失败的轮次只存了 user 没存 assistant
                # 回复，下一条 user 接在上一条后面就是交替违规。
                previous["content"] = _merge_content(previous.get("content"), row.get("content"))
            else:
                result.append(row)
    flush()
    return result


"""QA1102-13：回复承诺了「先去查/先做」却一个工具都没调时，适配器多走一步催它现在调。"""
_ACTION_NUDGE = "你刚才说要先查/先做——现在就调用工具执行，不要只回复文字说明。"
_ACTION_PROMISE = re.compile(
    r"我先(?:去|来|就|马上|现在|帮你)?(?:查|搜|看|找|试|确认|处理|接入|连接|问|弄|下载|打开)|"
    r"我来(?:查|搜|看|找|确认|处理|接入|连接|搜索|帮你)|"
    r"让我(?:先|来)?(?:查|搜|看|找|搜索|确认|试|问)|"
    r"我(?:这就|马上|现在|就|再|帮你)?(?:去|帮你)?(?:查|搜|搜索|看看|看|确认|找|处理|试|弄|问|下载|打开|接入|连接)|"
    r"\b(?:i(?:'ll|’ll| will)|let me|i'?m (?:going|gonna)\s*to|i am going to)\b"
    r"[^.!?。！？\n]{0,120}?\b(?:search|look(?:ing)?\s*(?:for|into|up|at)|check|find|fetch|dig|inspect|investigate|open|download|connect|try)\b",
    re.I,
)
"""QA1102-13 r1：已完成 / 过去时的说法——「我下载好了」「我找到了」「I've downloaded it」——
不是承诺，永不催。出现这些标记就一票否决。"""
_ACTION_DONE = re.compile(
    r"了|好了|已经|已完成|完成|找到[了得]?|查到|办妥|搞定|处理好|下好|"
    r"\b(?:i'?ve|i have|already|done|finished|completed|downloaded|found|checked|searched|handled|got it)\b",
    re.I,
)


def action_promise(text: Any) -> bool:
    """这段回复是不是「承诺行动」的话术：只有未来时承诺才算——已完成 / 过去时一律不催。"""
    return (isinstance(text, str) and not _ACTION_DONE.search(text)
            and bool(_ACTION_PROMISE.search(text)))


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


# Hermes FailoverReason values that mean "this model's quota / rate limit is used up". Everything
# else that makes Hermes switch (overloaded, server_error, timeout, ...) is "temporarily unavailable".
_QUOTA_REASONS = frozenset({"billing", "rate_limit", "upstream_rate_limit", "quota", "model_entitlement"})
# QA1102-14：还有一类——主模型拒绝了这一次请求本身（400 参数非法 / 上下文超长 / 内容拦截）。
# 模型没病，所以叫 "rejected"：不该进冷却 / 断路器，提示语也另有一句（「请求被主模型拒绝」）。
_REJECTED_REASONS = frozenset({"bad_request", "invalid_request", "malformed_request", "context_overflow",
                               "context_length", "payload_too_large", "long_context_tier",
                               "content_policy_blocked", "provider_policy_blocked"})


def fallback_reason(reason: Any) -> str:
    value = str(getattr(reason, "value", reason) or "").strip().lower()
    if value in _QUOTA_REASONS:
        return "quota"
    return "rejected" if value in _REJECTED_REASONS else "unavailable"


def fallback_use(primary: str, fallback: Any, reason: Any) -> dict[str, str] | None:
    """The host-facing record of one Hermes model switch: ids only, never provider text."""
    target = str(fallback or "").strip()
    if not target or target == primary or len(target) > 200 or any(c.isspace() for c in target):
        return None
    return {"from": primary, "to": target, "reason": fallback_reason(reason)}

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
    "region": "Hermes model call failed: unsupported_region (HTTP 403)",
    "invalid_request": "Hermes model call failed: invalid_request (HTTP 400)",
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
    "bad_request": "invalid_request", "invalid_request": "invalid_request",
    "malformed_request": "invalid_request",
    "incomplete_response": "stream",
}
# 403 is not always a key problem: providers also answer 403 for a blocked region or a content
# block. Only the error body can tell them apart; when it can't, the generic sentence is shown.
_STATUS = {401: "auth", 402: "quota", 404: "model_not_found", 408: "timeout", 413: "context_length",
           429: "rate_limit"}
_REGION = re.compile(r"unsupported[_ ]?(country|region|location|territory)|(country|region|territory|location)"
                     r"[^.]{0,40}\bnot (supported|available|allowed)|not available in your (country|region)", re.I)
_CONTENT = re.compile(r"content[_ ]?(filter|policy|management)|moderation|policy[_ ]?violation|flagged|safety[_ ]?(system|filter)", re.I)
_KEY = re.compile(r"invalid[_ ]?(api[_ ]?)?key|incorrect api key|api[_ ]?key|unauthori[sz]ed|authentication|invalid[_ ]?token", re.I)
# What a 4xx body (or an SDK error ``code``) may say when the status alone doesn't name the cause.
_BODY_HINTS = (
    ("region", _REGION),
    ("context_length", re.compile(r"context[_ ]?(length|window)|maximum context|too many tokens|prompt is too long", re.I)),
    ("content_filter", _CONTENT),
    ("quota", re.compile(r"insufficient[_ ]?quota|billing|credit balance", re.I)),
    ("rate_limit", re.compile(r"rate[_ ]?limit", re.I)),
    ("model_not_found", re.compile(r"model[_ ]not[_ ]found", re.I)),
    ("auth", re.compile(r"invalid[_ ]?api[_ ]?key", re.I)),
)
# Model SDKs whose exception class names are trusted. A class name or text match on anything else
# (a tool's FileNotFoundError, PermissionError("Permission denied"), "timed out"...) is not a model error.
_SDK_MODULES = frozenset({"openai", "anthropic", "litellm", "google", "groq", "mistralai", "cohere"})
_SDK_TYPES = {
    "RateLimitError": "rate_limit", "AuthenticationError": "auth", "NotFoundError": "model_not_found",
    "APITimeoutError": "timeout", "InternalServerError": "provider_unavailable",
    "ServiceUnavailableError": "provider_unavailable", "OverloadedError": "provider_unavailable",
    "ContextWindowExceededError": "context_length", "ContentPolicyViolationError": "content_filter",
}


_BODY_LIMIT = 64 * 1024


def _body_text(value: Any) -> str | None:
    if isinstance(value, (bytes, bytearray)):
        return bytes(value[:_BODY_LIMIT]).decode("utf-8", errors="replace")
    if isinstance(value, str):
        return value
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, ensure_ascii=False, default=str)
    return None


def _error_body(error: BaseException) -> str:
    """The error's code / type / body / message as one string (at most 64 KB), never raising."""
    try:
        parts = []
        for name in ("code", "type", "body", "message"):
            try:
                value = getattr(error, name, None)
            except Exception:
                continue
            text = _body_text(value)
            if text:
                parts.append(text[:_BODY_LIMIT])
        parts.append(str(error))
        return " ".join(parts)[:_BODY_LIMIT]
    except Exception:
        try:
            return str(error)[:_BODY_LIMIT]
        except Exception:
            return type(error).__name__


def _from_body(body: str) -> str | None:
    for category, pattern in _BODY_HINTS:
        if pattern.search(body):
            return category
    return None


def _from_403(body: str) -> str:
    if _REGION.search(body):
        return "region"
    if _CONTENT.search(body):
        return "content_filter"
    if _KEY.search(body):
        return "auth"
    return "unknown"


def _is_builtin(error: BaseException) -> bool:
    return isinstance(error, OSError) or type(error).__module__ == "builtins"


def _sdk_type(error: BaseException) -> str | None:
    if type(error).__module__.split(".", 1)[0] not in _SDK_MODULES:
        return None
    for cls in type(error).__mro__:
        if cls.__name__ in _SDK_TYPES:
            return _SDK_TYPES[cls.__name__]
    return None


def failure_category(reason: Any = None, error: BaseException | None = None) -> str:
    """Name what went wrong, from Hermes' classified reason or the exception chain; never its text.

    Only model-SDK exception types and HTTP statuses count. Built-in exceptions (OSError and its
    FileNotFoundError / PermissionError / TimeoutError, RuntimeError...) are skipped, so a tool's own
    failure is never dressed up as "model not found", "invalid key" or "model timeout".
    """
    if isinstance(reason, str) and reason in _REASONS:
        return _REASONS[reason]
    seen = 0
    while error is not None and seen < 5:
        seen += 1
        if not _is_builtin(error):
            status = getattr(error, "status_code", None)
            if not isinstance(status, int):
                status = getattr(error, "status", None)
            if isinstance(status, int) and not isinstance(status, bool):
                if status == 403:
                    return _from_403(_error_body(error))
                if status in _STATUS:
                    return _STATUS[status]
                if 500 <= status < 600:
                    return "provider_unavailable"
                if status in (400, 422):
                    # QA1102-14：400/422 是「这一次请求本身被拒」（参数非法 / 上下文超长），
                    # 不是模型坏了——归 invalid_request，绝不进冷却 / 断路器。
                    return _from_body(_error_body(error)) or "invalid_request"
                if 400 <= status < 500:
                    return _from_body(_error_body(error)) or "unknown"
            sdk = _sdk_type(error)
            if sdk:
                return sdk
            if type(error).__module__.split(".", 1)[0] in _SDK_MODULES:
                found = _from_body(_error_body(error))
                if found:
                    return found
        error = error.__cause__ or error.__context__
    return "unknown"


def failure_message(category: str) -> str:
    return _FAILURE_MESSAGES.get(category, TURN_FAILED)


# Hermes also narrates a failed model call as ordinary reply text written for a CLI
# operator: "<provider> rejected your API key, so the model can't be reached. Update
# it in Settings → Providers, or run `hermes setup` in a terminal." and a
# "Provider said: HTTP <status>: <upstream>" line. That prose is not an answer to the
# person in this conversation — these markers name only the shapes narration writes,
# so a turn can end in one classified sentence instead of storing the warning as its
# reply.
_REPLY_FAILURE = re.compile(
    r"provider said\s*:\s*http\b|rejected your (?:api[-_ ]?key|key|credentials?)|"
    r"'s sign-in was revoked|\w[\w-]* setup`?\s+in a terminal|settings ?→ ?providers", re.I)
_PROSE_HINTS = (
    ("auth", re.compile(r"rejected your (?:api[-_ ]?key|key|credentials?)|'s sign-in was revoked|"
                        r"sign in again|not signed in|invalid (?:api[-_ ]?key|token)", re.I)),
    ("rate_limit", re.compile(r"rate[- ]?limit|too many requests", re.I)),
    ("quota", re.compile(r"out of (?:credits|quota)|insufficient[_ ]?quota|billing|credit balance", re.I)),
    ("context_length", re.compile(r"context[_ ]?(?:window|length|overflow)|too many tokens|prompt is too long", re.I)),
    ("content_filter", _CONTENT),
    ("model_not_found", re.compile(r"model\b.{0,40}\b(?:not found|does not exist|unavailable|deprecat|retired)|no such model", re.I)),
    ("region", _REGION),
    ("timeout", re.compile(r"timed out|timeout|deadline", re.I)),
    ("provider_unavailable", re.compile(r"can't be reached|could not be reached|unreachable|service unavailable|overloaded", re.I)),
    # 放最后：前面几条更具体（context 过长、限流…），都认不出才是「请求本身被拒」。
    ("invalid_request", re.compile(r"invalid[_ ]?(input|request|param)|bad request|malformed", re.I)),
)
_HTTP_STATUS = re.compile(r"\bHTTP (\d{3})\b")


def reply_failure_category(text: Any) -> str | None:
    """Category when text is Hermes' own provider-failure narration, else None.

    The category is read off the prose itself: an embedded ``HTTP <status>`` first,
    then the same keyword hints a 4xx body gets. A match that names nothing still
    fails the turn — only with the generic sentence.
    """
    if not isinstance(text, str) or not _REPLY_FAILURE.search(text):
        return None
    match = _HTTP_STATUS.search(text)
    if match:
        status = int(match.group(1))
        if status == 403:
            return _from_403(text)
        if status in _STATUS:
            return _STATUS[status]
        if status in (400, 422):
            for category, pattern in _PROSE_HINTS:
                if pattern.search(text):
                    return category
            return "invalid_request"
        if status >= 500:
            return "provider_unavailable"
    for category, pattern in _PROSE_HINTS:
        if pattern.search(text):
            return category
    return "unknown"


def _reply_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(block.get("text") or "" for block in content if isinstance(block, dict))
    return ""


def turn_failure(result: Any) -> str | None:
    """Category when a Hermes turn result is a model-call failure, else None.

    ``failed`` (or ``failure_reason`` on its own, for a Hermes that skips the flag) is
    the documented witness; the reply text is the third. A turn that "succeeds" with
    nothing but provider narration fails here rather than storing the prose as its
    answer.
    """
    if not isinstance(result, dict):
        return None
    if result.get("failed") or result.get("failure_reason"):
        return failure_category(result.get("failure_reason"))
    found = reply_failure_category(result.get("final_response"))
    if found is not None:
        return found
    history = result.get("messages")
    if isinstance(history, list):
        for message in reversed(history):
            if isinstance(message, dict) and message.get("role") == "assistant":
                return reply_failure_category(_reply_text(message.get("content")))
    return None
