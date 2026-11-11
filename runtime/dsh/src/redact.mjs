/**
 * Redaction for model failure text before the DSH session stores it (QA510 P3).
 *
 * Upstream 4xx/5xx bodies quote whatever they were sent: request content, the Authorization
 * header, the endpoint with its credentials, internal addresses. The session event log keeps
 * failures for the transcript and for routing records, so the text is masked here first and
 * capped: what a failure needs to say fits in a few hundred characters. The server masks again
 * with its own rules before anything reaches a browser.
 */
const MASK = "••••";
const HOST_MASK = "[内网地址]";
export const FAILURE_TEXT_MAX = 300;

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const PRIVATE_V4 = `(?:10\\.${OCTET}|127\\.${OCTET}|192\\.168|169\\.254|172\\.(?:1[6-9]|2\\d|3[01])|100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])|0\\.${OCTET})\\.${OCTET}\\.${OCTET}`;

const SHAPES = [
  // scheme://user:password@ (any scheme; the password may hold unencoded @ / # ?).
  [
    /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:"'<>]*:[^\s"'<>]*@/gi,
    `$1${MASK}:${MASK}@`,
  ],
  // Authorization: Bearer xxx / token xxx / Basic xxx
  [/\b(bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  // key=value / "api_key": "value"
  [
    /\b((?:api[_-]?key|access[_-]?key|secret|password|passwd|token|x-api-key)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
    `$1${MASK}`,
  ],
  // Known key prefixes. `sk-` of any length: a short echoed fragment is still a key fragment.
  [
    /\b(?:sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abpr]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g,
    MASK,
  ],
  [
    new RegExp(`\\b${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}:\\d{1,5}\\b`, "g"),
    HOST_MASK,
  ],
  [new RegExp(`\\b${PRIVATE_V4}\\b`, "g"), HOST_MASK],
  [
    /\[(?:::1|f[cd][0-9a-f]{2}:[0-9a-f:]*|fe80:[0-9a-f:]*)\](?::\d{1,5})?/gi,
    HOST_MASK,
  ],
  [
    /(?<![\w:])(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):(?::{0,2}[0-9a-f]{1,4}){1,7}(?:%[\w.-]+)?(?![\w:])/gi,
    HOST_MASK,
  ],
  [/\blocalhost(?::\d{1,5})?\b/gi, HOST_MASK],
  [
    /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|local|lan|svc|cluster\.local|intranet|corp)(?::\d{1,5})?\b/gi,
    HOST_MASK,
  ],
];

/** Masked and capped failure text. Idempotent. */
export function redactFailureText(text) {
  let out = String(text ?? "");
  for (const [shape, replacement] of SHAPES)
    out = out.replace(shape, replacement);
  out = out.trim();
  return out.length > FAILURE_TEXT_MAX
    ? `${out.slice(0, FAILURE_TEXT_MAX)}…`
    : out;
}
