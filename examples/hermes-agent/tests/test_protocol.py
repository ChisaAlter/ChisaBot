from __future__ import annotations

import copy
import io
import json
from pathlib import Path
import sys
import threading
import unittest
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from chisabot_protocol import (Gateway, GatewayClient, GatewayError, ProtocolError, RunState,
                               ToolAliases, ToolSuspended, TURN_FAILED, failure_category,
                               failure_message, host_metadata, parse_host_prompt)


def payload():
    return {"version": 1, "scope": {"actorId": "actor", "botId": "bot", "threadId": "thread", "runId": "run"},
            "systemPrompt": "Host identity", "history": [{"role": "user", "content": "Earlier question"},
                {"role": "assistant", "content": None, "tool_calls": [{"id": "model-call-1", "type": "function",
                    "function": {"name": "device_list", "arguments": "{}"}}]},
                {"role": "tool", "tool_call_id": "model-call-1", "content": "[]"}],
            "tools": [{"name": "device_list", "description": "List granted devices",
                       "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer"}},
                                       "additionalProperties": False}}],
            "toolGateway": {"url": "http://host.invalid/runs/abc", "capability": "opaque-capability-secret"},
            "model": {"id": "magpie-model"}}


class Response(io.BytesIO):
    def __init__(self, body, status=200):
        super().__init__(json.dumps(body).encode())
        self.status = status

    def getcode(self):
        return self.status


class ProtocolTests(unittest.TestCase):
    def test_schema_and_history_mapping_preserves_real_ids_and_null(self):
        raw = payload()
        raw["history"][0]["metadata"] = {"secret": "must not reach model"}
        raw["history"][0]["_meta"] = {"chisabot": raw["toolGateway"]}
        config = parse_host_prompt(raw)
        self.assertEqual(config.tools[0].registry_schema(), {"name": "device_list", "description": "List granted devices",
                                                          "parameters": raw["tools"][0]["inputSchema"]})
        self.assertIsNone(config.history[1]["content"])
        self.assertEqual(config.history[1]["tool_calls"][0]["id"], "model-call-1")
        self.assertEqual(config.history[2]["tool_call_id"], "model-call-1")
        self.assertNotIn("metadata", config.history[0])
        self.assertNotIn("_meta", config.history[0])
        config.history[0]["content"] = "changed"
        self.assertEqual(raw["history"][0]["content"], "Earlier question")
        self.assertNotIn(raw["toolGateway"]["capability"], repr(config))

    def test_metadata_supports_router_flattening_and_direct_calls(self):
        raw = payload()
        for metadata in ({"chisabot": raw}, {"_meta": {"chisabot": raw}}, {"field_meta": {"chisabot": raw}}):
            self.assertEqual(host_metadata(metadata), raw)
        self.assertIsNone(host_metadata({"chisabotNamespace": "hash"}, required=False))
        with self.assertRaisesRegex(ProtocolError, "Missing"):
            host_metadata({})
        with self.assertRaises(ProtocolError):
            host_metadata({"chisabot": raw, "_meta": {"chisabot": raw}})

    def test_bad_payloads_fail_without_echoing_values(self):
        mutations = [lambda p: p.update(version=2), lambda p: p.update(version=True), lambda p: p.pop("history"),
                     lambda p: p["scope"].pop("actorId"), lambda p: p.update(systemPrompt=None),
                     lambda p: p["tools"][0].update(inputSchema=[]),
                     lambda p: p["tools"][0].update(inputSchema={"type": "array"}),
                     lambda p: p["tools"].append(copy.deepcopy(p["tools"][0])),
                     lambda p: p["tools"][0].update(name="unsafe.name"),
                     lambda p: p["toolGateway"].update(capability="secret\r\nheader"),
                     lambda p: p["toolGateway"].update(url="http://secret@host.invalid/"),
                     lambda p: p["toolGateway"].update(url="http://host.invalid/?secret=yes"),
                     lambda p: p["history"].append({"role": "system", "content": "bad"}),
                     lambda p: p.update(model={"id": ""}), lambda p: p.update(continuation="true")]
        for mutate in mutations:
            raw = payload()
            mutate(raw)
            with self.subTest(mutation=mutate), self.assertRaises(ProtocolError) as error:
                parse_host_prompt(raw)
            self.assertNotIn("opaque-capability-secret", str(error.exception))

    def test_capability_is_never_model_visible(self):
        for field in ("systemPrompt", "history", "currentMessage", "tools"):
            raw = payload()
            secret = raw["toolGateway"]["capability"]
            if field == "systemPrompt":
                raw[field] = "Identity " + secret
            elif field == "history":
                raw[field][0]["content"] = secret
            elif field == "currentMessage":
                raw[field] = {"role": "user", "content": secret}
            else:
                raw[field][0]["description"] = secret
            with self.subTest(field=field), self.assertRaisesRegex(ProtocolError, "model-visible"):
                parse_host_prompt(raw)

    def test_current_message_preserves_openai_multimodal_blocks(self):
        raw = payload()
        raw["currentMessage"] = {"role": "user", "content": [{"type": "text", "text": "Describe"},
            {"type": "image_url", "image_url": {"url": "https://image.invalid/a.png", "detail": "high"}}],
            "metadata": {"hidden": "x"}}
        config = parse_host_prompt(raw)
        self.assertEqual(config.current_message["content"], raw["currentMessage"]["content"])
        self.assertNotIn("metadata", config.current_message)
        self.assertEqual(len(config.history), 3)
        raw["currentMessage"]["role"] = "assistant"
        with self.assertRaises(ProtocolError):
            parse_host_prompt(raw)


class AliasTests(unittest.TestCase):
    def test_long_connector_names_have_stable_bounded_hash_aliases(self):
        raw = payload()
        name = "connectors__" + "long_name_" * 11
        raw["tools"][0]["name"] = name
        config = parse_host_prompt(raw)
        first = ToolAliases.for_prompt(config, set())
        second = ToolAliases.for_prompt(config, set())
        alias = first.internal(name)
        self.assertTrue(alias.startswith("chisabot_host_"))
        self.assertLessEqual(len(alias), 64)
        self.assertEqual(first.to_internal, second.to_internal)
        self.assertEqual(first.canonical(alias), name)
        self.assertNotEqual(alias, "chisabot_host_" + name)

    def test_text_replacement_respects_complete_tool_name_boundaries(self):
        raw = payload()
        raw["tools"][0]["name"] = "delegate_task"
        aliases = ToolAliases.for_prompt(parse_host_prompt(raw), {"delegate_task"})
        self.assertEqual(aliases.text("`delegate_task` / delegate_task.extra / delegate_task_extra / xdelegate_task / delegate_task-more"),
                         "`chisabot_host_delegate_task` / chisabot_host_delegate_task.extra / delegate_task_extra / xdelegate_task / delegate_task-more")
        self.assertEqual(aliases.text("chisabot_host_delegate_task", canonical=True), "delegate_task")
        self.assertIsNone(aliases.text(None))

    def test_history_only_structured_tool_names_change(self):
        raw = payload()
        raw["history"][0]["content"] = "delegate_task is user text"
        raw["history"][1]["content"] = "delegate_task is assistant text"
        raw["history"][1]["tool_calls"][0]["function"] = {"name": "delegate_task", "arguments": '{"value":"delegate_task"}'}
        raw["history"][2].update(name="delegate_task", tool_name="delegate_task", content="delegate_task result value")
        config = parse_host_prompt(raw)
        aliases = ToolAliases.for_prompt(config, {"delegate_task"})
        mapped = aliases.history(config.history)
        self.assertEqual(mapped[0]["content"], "delegate_task is user text")
        self.assertEqual(mapped[1]["content"], "delegate_task is assistant text")
        self.assertEqual(mapped[1]["tool_calls"][0]["function"]["arguments"], '{"value":"delegate_task"}')
        self.assertEqual(mapped[2]["content"], "delegate_task result value")
        self.assertEqual(mapped[2]["name"], "chisabot_host_delegate_task")
        self.assertEqual(mapped[1]["tool_calls"][0]["id"], "model-call-1")
        self.assertEqual(mapped[2]["tool_call_id"], "model-call-1")
        self.assertEqual(aliases.history(mapped, canonical=True), config.history)
        self.assertEqual(config.history[2]["name"], "delegate_task")

    def test_history_alias_colliding_with_current_tool_fails_closed(self):
        raw = payload()
        raw["tools"][0]["name"] = "chisabot_host_delegate_task"
        raw["history"][1]["tool_calls"][0]["function"]["name"] = "delegate_task"
        with self.assertRaisesRegex(ProtocolError, "collides"):
            ToolAliases.for_prompt(parse_host_prompt(raw), {"delegate_task"})


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.gateway = Gateway("http://host.invalid/run", "opaque-capability-secret")

    def test_http_request_has_exact_id_body_and_bearer_header(self):
        requests = []
        def transport(request, timeout):
            requests.append((request, timeout))
            return Response({"result": "tool output"})
        client = GatewayClient(self.gateway, transport=transport, timeout=2)
        self.assertEqual(client.call("provider:id/42", "device_list", {"limit": 4}), "tool output")
        request, timeout = requests[0]
        self.assertEqual(request.full_url, "http://host.invalid/run/tools/call")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("Authorization"), "Bearer opaque-capability-secret")
        self.assertEqual(json.loads(request.data), {"callId": "provider:id/42", "name": "device_list", "args": {"limit": 4}})
        self.assertNotIn("opaque-capability-secret", request.data.decode())
        self.assertEqual(timeout, 2)

    def test_result_and_error_bodies_redact_transport_secrets(self):
        client = GatewayClient(self.gateway, transport=lambda *_a, **_kw: Response({"result": "opaque-capability-secret"}))
        self.assertEqual(client.call("id", "device_list", {}), "[REDACTED]")
        client = GatewayClient(self.gateway, transport=lambda *_a, **_kw: Response(
            {"error": {"code": "tool_failed", "message": "opaque-capability-secret"}}, 500))
        with self.assertRaises(GatewayError) as error:
            client.call("id", "device_list", {})
        self.assertNotIn("opaque-capability-secret", str(error.exception))
        self.assertEqual(error.exception.code, "tool_failed")

    def test_network_exceptions_are_sanitized(self):
        def broken(*_a, **_kw):
            raise OSError("opaque-capability-secret URL Authorization body")
        client = GatewayClient(self.gateway, transport=broken)
        with self.assertRaisesRegex(GatewayError, "could not be reached") as error:
            client.call("id", "device_list", {})
        self.assertIsNone(error.exception.__cause__)
        self.assertNotIn("opaque-capability-secret", str(error.exception))

    def test_http_error_suspension_preserves_waiting(self):
        waiting = {"kind": "approval", "continuation": {"id": "continue-me"}, "accidental": "opaque-capability-secret"}
        data = json.dumps({"error": {"code": "tool_suspended", "message": "opaque-capability-secret"}, "waiting": waiting}).encode()
        def transport(*_a, **_kw):
            raise HTTPError("http://host.invalid", 409, "conflict", {}, io.BytesIO(data))
        with self.assertRaises(ToolSuspended) as error:
            GatewayClient(self.gateway, transport=transport).call("actual-call", "device_list", {})
        self.assertEqual(error.exception.waiting["continuation"], {"id": "continue-me"})
        self.assertEqual(error.exception.waiting["accidental"], "[REDACTED]")

    def test_non_suspension_conflict_and_redirect_fail(self):
        for code, body in [(409, {"error": {"code": "call_conflict", "message": "body"}}),
                           (302, {"result": "redirected"}), (200, {"error": "bad"}),
                           (409, {"error": {"code": "tool_suspended"}})]:
            with self.subTest(status=code, body=body), self.assertRaises(GatewayError):
                GatewayClient(self.gateway, transport=lambda *_a, **_kw: Response(body, code)).call("id", "device_list", {})

    def test_default_transport_disallows_redirects_and_proxies(self):
        handlers = GatewayClient(self.gateway)._transport.__self__.handlers
        redirect = next(h for h in handlers if h.__class__.__name__ == "_NoRedirect")
        self.assertIsNone(redirect.redirect_request(None, None, 302, "redirect", {}, "http://other.invalid"))
        self.assertFalse(any(h.__class__.__name__ == "ProxyHandler" and h.proxies for h in handlers))


class RunStateTests(unittest.TestCase):
    def make_run(self, transport):
        config = parse_host_prompt(payload())
        interrupts = []
        return RunState("session", config, lambda: interrupts.append(True),
                        GatewayClient(config.gateway, transport=transport)), interrupts

    def test_id_requires_successful_start_ack_before_http(self):
        calls = []
        run, interrupted = self.make_run(lambda *_a, **_kw: calls.append(True))
        result = json.loads(run.execute("real-id", "device_list", {}))
        self.assertEqual(result["error"]["code"], "tool_start_required")
        self.assertFalse(calls)
        self.assertTrue(interrupted)
        run, interrupted = self.make_run(lambda *_a, **_kw: Response({"result": "ok"}))
        def bad_start():
            raise RuntimeError("opaque-capability-secret")
        run.start("real-id", "device_list", {}, bad_start)
        self.assertEqual(run.fatal_error, "ACP tool start could not be delivered")
        self.assertEqual(json.loads(run.execute("real-id", "device_list", {}))["error"]["code"], "run_closed")

    def test_suspension_stops_later_handlers_and_streaming(self):
        calls = []
        def transport(request, timeout):
            calls.append(json.loads(request.data))
            return Response({"error": {"code": "tool_suspended"}, "waiting": {"kind": "approval"}}, 409)
        run, interrupted = self.make_run(transport)
        run.start("real-id", "device_list", {}, lambda: None)
        result = run.execute("real-id", "device_list", {})
        self.assertNotIn("waiting", result)
        self.assertEqual(run.response_meta(), {"version": 1, "callId": "real-id", "name": "device_list", "waiting": {"kind": "approval"}})
        self.assertFalse(run.may_stream())
        run.start("later", "device_list", {}, lambda: self.fail("no start after suspension"))
        run.execute("later", "device_list", {})
        self.assertEqual(len(calls), 1)
        self.assertTrue(interrupted)

    def test_parallel_handlers_are_serialized_before_suspension(self):
        entered, release = threading.Event(), threading.Event()
        calls = []
        def transport(request, timeout):
            calls.append(json.loads(request.data)["callId"])
            entered.set()
            self.assertTrue(release.wait(2))
            return Response({"error": "tool_suspended", "waiting": {"kind": "approval"}}, 409)
        run, _ = self.make_run(transport)
        for call_id in ("first", "second"):
            run.start(call_id, "device_list", {}, lambda: None)
        first = threading.Thread(target=run.execute, args=("first", "device_list", {}))
        second = threading.Thread(target=run.execute, args=("second", "device_list", {}))
        first.start()
        self.assertTrue(entered.wait(2))
        second.start()
        release.set()
        first.join(2)
        second.join(2)
        self.assertFalse(first.is_alive() or second.is_alive())
        self.assertEqual(calls, ["first"])

    def test_unknown_gateway_outcomes_interrupt_and_block_later_calls(self):
        def network_failure(*_a, **_kw):
            raise TimeoutError("capability must not leak")
        cases = [network_failure,
                 lambda *_a, **_kw: Response({"error": {"code": "tool_failed"}}, 500),
                 lambda *_a, **_kw: Response({"unexpected": "lost result"}),
                 lambda *_a, **_kw: Response({"error": {"code": "invalid_capability"}}, 401),
                 lambda *_a, **_kw: Response({"error": {"code": "call_conflict"}}, 409)]
        for transport in cases:
            calls = []
            def counted(*args, **kwargs):
                calls.append(True)
                return transport(*args, **kwargs)
            run, interrupted = self.make_run(counted)
            run.start("first", "device_list", {}, lambda: None)
            run.start("second", "device_list", {}, lambda: None)
            run.execute("first", "device_list", {})
            with self.subTest(transport=transport):
                self.assertTrue(run.fatal_error)
                self.assertTrue(interrupted)
                self.assertFalse(run.may_stream())
                self.assertEqual(json.loads(run.execute("second", "device_list", {}))["error"]["code"], "run_closed")
                self.assertEqual(len(calls), 1)

    def test_definitive_schema_rejection_can_return_normal_tool_error(self):
        for status, code in ((400, "invalid_arguments"), (400, "invalid_call"), (404, "unknown_tool")):
            run, interrupted = self.make_run(lambda *_a, **_kw: Response({"error": {"code": code}}, status))
            run.start("first", "device_list", {}, lambda: None)
            result = json.loads(run.execute("first", "device_list", {}))
            with self.subTest(status=status, code=code):
                self.assertEqual(result["error"]["code"], code)
                self.assertIsNone(run.fatal_error)
                self.assertFalse(interrupted)
                self.assertTrue(run.may_stream())

    def test_default_timeout_allows_long_host_confirmations(self):
        run, _ = self.make_run(lambda *_a, **_kw: Response({"result": "ok"}))
        self.assertGreaterEqual(run.client.timeout, 15 * 60)

    def test_closed_run_rejects_old_handlers(self):
        run, _ = self.make_run(lambda *_a, **_kw: self.fail("closed run cannot call gateway"))
        run.start("old", "device_list", {}, lambda: None)
        run.close()
        self.assertEqual(json.loads(run.execute("old", "device_list", {}))["error"]["code"], "run_closed")


class FailureCategoryTests(unittest.TestCase):
    def test_hermes_reasons_fold_into_fixed_categories(self):
        cases = {"rate_limit": "rate_limit", "upstream_rate_limit": "rate_limit", "billing": "quota",
                 "auth_permanent": "auth", "context_overflow": "context_length", "payload_too_large": "context_length",
                 "timeout": "timeout", "overloaded": "provider_unavailable", "server_error": "provider_unavailable",
                 "model_not_found": "model_not_found", "content_policy_blocked": "content_filter",
                 "incomplete_response": "stream", "format_error": "unknown", None: "unknown"}
        for reason, category in cases.items():
            self.assertEqual(failure_category(reason), category, reason)

    def test_exception_chain_status_code_and_names(self):
        class RateLimitError(Exception):
            pass
        RateLimitError.__module__ = "openai._exceptions"
        class APIStatusError(Exception):
            def __init__(self, status):
                super().__init__("opaque")
                self.status_code = status
        self.assertEqual(failure_category(error=RateLimitError("x")), "rate_limit")
        self.assertEqual(failure_category(error=APIStatusError(503)), "provider_unavailable")
        self.assertEqual(failure_category(error=APIStatusError(413)), "context_length")
        class APITimeoutError(Exception):
            pass
        APITimeoutError.__module__ = "openai._exceptions"
        self.assertEqual(failure_category(error=APITimeoutError("Request timed out.")), "timeout")
        try:
            try:
                raise APIStatusError(429)
            except APIStatusError as inner:
                raise RuntimeError("wrapped") from inner
        except RuntimeError as outer:
            self.assertEqual(failure_category(error=outer), "rate_limit")
        self.assertEqual(failure_category(error=RuntimeError("opaque-capability-secret")), "unknown")

    def test_builtin_and_tool_errors_are_not_model_errors(self):
        # #416 review: these used to read as "model not found", "invalid key" and "model timeout".
        self.assertEqual(failure_category(error=FileNotFoundError(2, "No such file or directory", "notes.txt")), "unknown")
        self.assertEqual(failure_category(error=PermissionError("Permission denied")), "unknown")
        self.assertEqual(failure_category(error=RuntimeError("tool web_fetch timed out after 30s")), "unknown")
        self.assertEqual(failure_category(error=TimeoutError("read timed out")), "unknown")
        class ToolError(Exception):  # a tool's own exception type, not a model SDK's
            pass
        self.assertEqual(failure_category(error=ToolError("NotFound: model_not_found timed out")), "unknown")
        # A built-in wrapper still lets the real model error underneath count.
        class RateLimitError(Exception):
            pass
        RateLimitError.__module__ = "openai._exceptions"
        try:
            try:
                raise RateLimitError("x")
            except RateLimitError as inner:
                raise FileNotFoundError("Permission denied timed out") from inner
        except FileNotFoundError as outer:
            self.assertEqual(failure_category(error=outer), "rate_limit")

    def test_403_reads_the_body_before_calling_it_auth(self):
        class PermissionDeniedError(Exception):
            status_code = 403
            def __init__(self, message, body=None, code=None):
                super().__init__(message)
                self.body = body
                self.code = code
        PermissionDeniedError.__module__ = "openai._exceptions"
        region = PermissionDeniedError("Country, region, or territory not supported",
                                       body={"error": {"code": "unsupported_country_region_territory"}},
                                       code="unsupported_country_region_territory")
        self.assertEqual(failure_category(error=region), "region")
        self.assertEqual(failure_category(error=PermissionDeniedError("Request blocked by content filter")), "content_filter")
        self.assertEqual(failure_category(error=PermissionDeniedError("x", body={"error": {"type": "policy_violation"}})),
                         "content_filter")
        self.assertEqual(failure_category(error=PermissionDeniedError("Invalid API key provided")), "auth")
        self.assertEqual(failure_category(error=PermissionDeniedError("Forbidden")), "unknown")
        self.assertEqual(failure_message("region"), "Hermes model call failed: unsupported_region (HTTP 403)")
        self.assertEqual(failure_message(failure_category(error=PermissionDeniedError("Forbidden"))), TURN_FAILED)

    def test_messages_are_fixed_and_unknown_keeps_old_sentence(self):
        self.assertEqual(failure_message("unknown"), TURN_FAILED)
        self.assertEqual(failure_message("rate_limit"), "Hermes model call failed: rate_limit (HTTP 429)")


if __name__ == "__main__":
    unittest.main()
