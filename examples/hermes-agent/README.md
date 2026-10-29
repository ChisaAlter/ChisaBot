# ChisaBot Hermes ACP host-tools adapter

This adapter targets the existing Hermes checkout at commit
`40cc180823d182826536416de2fc27be44b4ac57`. It subclasses the native
`HermesACPAgent`; it neither forks upstream nor uses an MCP tool proxy.

Use the server's **existing Hermes venv** and source checkout. There is no
installation step. The Team Lead owns real server validation; the local test
suite uses only standard-library fakes and never imports an installed Hermes.

```sh
export HERMES_SOURCE_DIR=/absolute/path/to/existing/hermes-agent
export HERMES_DISABLE_LAZY_INSTALLS=1
/path/to/existing/hermes-agent/.venv/bin/python /path/to/chisabot_acp.py --check
/path/to/existing/hermes-agent/.venv/bin/python /path/to/chisabot_acp.py
```

`HERMES_SOURCE_DIR` is required and is placed first on `sys.path` before any
Hermes import. The entry enforces `HERMES_DISABLE_LAZY_INSTALLS=1`. `--check`
imports the existing dependencies and checks the required callback/registry/
model-switch signatures without creating a session, invoking a model, or
starting the ACP stdio server. It is an import/API check, not a model or HTTP
readiness probe. Normal startup loads the existing Hermes home `.env` and uses
its provider configuration. Stdout is reserved for ACP JSON-RPC.

## Wire contract

`initialize` declares `_meta.chisabotHostTools: 1` at the response root and
inside `agentCapabilities._meta`. Unsupported persistent load/resume/fork/list
capabilities are not advertised. `session/new` accepts an empty `mcpServers`
array and optional `_meta.chisabotNamespace` (the adapter ignores this bridge
routing hint). MCP servers are rejected. Full host metadata is optional on
`session/new`, required on **every** `session/prompt`:

```json
{
  "version": 1,
  "scope": {"actorId": "actor", "botId": "bot", "threadId": "thread", "runId": "run"},
  "systemPrompt": "The ChisaBot identity and instructions",
  "history": [{"role": "user", "content": "Earlier user message"}],
  "tools": [{"name": "device_list", "description": "List granted devices", "inputSchema": {"type": "object", "properties": {}}}],
  "toolGateway": {"url": "http://reachable-host/run-base", "capability": "opaque-run-capability"},
  "model": {"id": "the-configured-model-id"}
}
```

The object is sent in `params._meta.chisabot`. The ACP SDK normally flattens
metadata keys into Python kwargs; direct Python callers can also use `_meta`
or `field_meta`. `history` contains prior OpenAI `user`/`assistant`/`tool`
messages; system instructions belong in `systemPrompt`. Assistant
`content: null`, `tool_calls`, original tool IDs and tool-result pairing are
preserved. Message transport/UI metadata is stripped. The current user block
is sent in ACP `prompt`, with optional `currentMessage` holding the complete
OpenAI **user** message so remote `image_url` blocks survive unchanged.

On continuation the bridge sends authoritative history including the real
resumed tool result, `continuation: true`, and a short ACP continue instruction.
The adapter does not replay the original user request and removes this
synthetic instruction from its returned in-memory history. The bridge remains
the canonical history owner.

The first configured prompt pins `(actorId, botId, threadId)` to the ACP session;
`runId` may change per turn. Each prompt replaces `state.history` and sets
`agent.ephemeral_system_prompt`. Scope, gateway URL and bearer capability are
never appended to user/system/history text. The validator refuses a capability
accidentally copied into model-visible content. Model selection goes through
native `set_session_model(model_id=...)`, whose `keep_endpoint=True` path keeps
the existing Magpie endpoint for the same provider. Unknown/rejected models
produce an ACP invalid-params error; no silent model fallback is implemented
by this adapter.

A model call that fails is reported as an ACP `-32603` error with one fixed
sentence per category (`rate_limit`, `quota`, `auth`, `context_length`,
`timeout`, `provider_unavailable`, `model_not_found`, `content_filter`,
`stream`; see `_FAILURE_MESSAGES` in `chisabot_protocol.py`). The category comes
from Hermes' `failure_reason` when it returns a failed result, or from the
exception's status code and type; the provider's own text is never forwarded.
Anything unclassified keeps the old `Hermes host turn execution failed`. The web
app's `friendly-error.ts` turns each sentence into its Chinese headline and
next step (`app/tests/hermes-error-categories.test.ts` keeps both sides in step).

## Tools and waiting

Schemas map from `inputSchema` to Hermes registry `parameters`. Tools are
registered under `toolset='chisabot'`, `scope=sessionId`; execution is wrapped
in `session_tool_scope(sessionId)`. The agent exposes precisely those schemas
and names, with no extra native todo/terminal/files/network tools. Names that
Hermes intercepts before registry dispatch (inline tools, legacy aliases,
connector dispatch, tool search bridges) receive private, deterministic
`chisabot_host_<name>` names inside Hermes. Names over 64 characters use a
stable SHA-256 suffix. These aliases apply only to registered schema names,
exact tool references in system/tool descriptions, and structured historical
tool names. JSON arguments, message bodies and result values are preserved.
Historical tools that are no longer offered are mapped for transcript
consistency but receive no schema or execution permission.

Callbacks translate private names back to the original ChisaBot name before
recording a start/result; the gateway, waiting metadata and all ACP tool events
retain canonical host names and the original provider call IDs. Returned
history is converted back to canonical tool names. Aliases live per session,
and any collision with another current or historical host name fails closed
before registration. Native inline tools are never enabled by this mapping.

The original `tool_start_callback(callId, name, args)` sends an ACP
`tool_call` update and **waits for successful delivery** before permitting HTTP.
Its `rawInput` is the complete final argument object, marked
`_meta.chisabot.inputComplete: true`; the bridge must emit canonical argument
and end events immediately rather than wait for the tool result, which would
create a capture/execution deadlock. Hermes swallows callback exceptions, so
the adapter also latches a delivery
failure in its run state; handlers fail closed if no acknowledged start exists.
The handler reads the real provider ID from
`tools.approval_context._approval_tool_call_id.get()` and sends exactly:

```http
POST <toolGateway.url>/tools/call
Authorization: Bearer <capability>
Content-Type: application/json

{"callId":"the-original-model-call-id","name":"device_list","args":{}}
```

The HTTP transport disables proxies and redirects, bounds responses, performs
no retries, and uses a 910-second timeout so host approvals or computer actions
can wait without a premature retry. It emits fixed error descriptions rather
than leaking upstream exception/error bodies. Network failures, malformed
responses, 5xx responses and authorization/run conflicts immediately stop the
turn because the host side effect may already have happened. Only explicit
400 invalid-arguments/invalid-call and 404 unknown-tool rejections are ordinary
tool failures. Expected success: `200 {"result":"original tool result"}`.
JSON-valued `result` and an optional `ok: true` wrapper are also accepted.

Suspension response:

```json
{"error":{"code":"tool_suspended","message":"Waiting"},"waiting":{"kind":"approval","continuation":{"id":"opaque-continuation"}}}
```

This is recognized only with HTTP 409. The adapter retains `waiting`, requests
an immediate hard interrupt, suppresses later text/reasoning, and prevents all
later host handlers from sending HTTP. A separate dispatch lock serializes
HTTP even if Hermes schedules host calls concurrently. Waiting workers check
the latch after the preceding response. An already sent request cannot be
retracted; the host gateway must also enforce run closure/suspension.

The waiting tool update carries the original `toolCallId`, `status: 'pending'`,
null result/content, and `_meta: {name, chisabot: {version: 1, callId, name, waiting}}`.
The prompt response overrides ordinary stop behavior:

```json
{"stopReason":"cancelled","_meta":{"chisabot":{"version":1,"callId":"the-original-model-call-id","name":"device_list","waiting":{"kind":"approval","continuation":{"id":"opaque-continuation"}}}}}
```

The model sees only a fixed interruption marker, never the waiting object or
continuation. The bridge translates this metadata to its interrupt/waiting
state. Normal `tool_call_update` events use the original ID and original string
`rawOutput`. Default native progress/step projections are disabled to avoid
duplicate synthetic IDs; native message/reasoning callbacks remain active.

## Isolation and tests

The default manager constructs native `AIAgent` with `skip_memory`,
`skip_background_review`, `skip_context_files`, disabled soul loading,
checkpoints and trajectories. It skips configured MCP discovery and uses no
Hermes transcript database or tool-pin persistence. The session is ephemeral;
the bridge supplies the full context each turn. Normal ACP cancel closes the
HTTP and text gates before interrupting Hermes. Local Hermes tool names are
not an authorization mechanism; the capability-scoped host gateway is the
execution authority.

Run locally with any existing Python 3.10+ runtime:

```sh
python -B -m unittest discover -s examples/hermes-agent/tests -v
```

The tests use explicit fake ACP/Hermes modules and injected in-memory HTTP
responses. They open no sockets and require no third-party packages. They
cover payload/schema validation, history replacement and multimodal mapping,
HTTP bearer/ID mapping, errors and redaction, session separation, missing tool
start/ID rejection, callback delivery ordering, waiting/cancel gates, parallel
handler fail-closed behavior, source pinning, and native construction flags.
Real Hermes import, network/model requests and server readiness remain server
integration checks performed by the Team Lead using the existing venv.
