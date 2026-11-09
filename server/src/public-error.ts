import { redactText, redactUserinfo } from "./computer/activity-redact";
import { reasonWithoutStatement } from "./db/query-failure";

/**
 * The one redaction for failure text that leaves the server process (QA508 F1).
 *
 * CRITERION. Nothing a run failure writes to the RUN_ERROR stream, the database, the browser or a
 * log line carries an API key, URL credentials, an internal address (private / loopback IP, any
 * IP with a port, localhost, *.internal-style hosts) or an SQL statement.
 *
 * REASON. Runtime and provider errors quote whatever they were handed: the upstream URL with its
 * userinfo, the Authorization header, the deployment's internal host:port, the failed query. Each
 * path used to clean (or not) on its own; every path now goes through here.
 */
const PUBLIC_ERROR_MAX = 300;
export const GENERIC_FAILURE = "会话执行失败。";
const HOST_MASK = "[内网地址]";
const SQL_MASK = "[SQL 已隐藏]";

const SQL_SHAPES: RegExp[] = [
  // drizzle / postgres.js: "Failed query: <statement>\nparams: <values>" — everything after it.
  /\bfailed query:[\s\S]*$/gi,
  /\bparams:[\s\S]*$/gi,
  /\bselect\b[^;\n]{0,400}?\bfrom\b[^;\n]*/gi,
  /\binsert\s+into\b[^;\n]*/gi,
  /\bupdate\s+\S+\s+set\b[^;\n]*/gi,
  /\bdelete\s+from\b[^;\n]*/gi,
  /\b(?:create|drop|alter|truncate)\s+(?:table|index|schema|database)\b[^;\n]*/gi,
];

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const PRIVATE_V4 = `(?:10\\.${OCTET}|127\\.${OCTET}|192\\.168|169\\.254|172\\.(?:1[6-9]|2\\d|3[01])|100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])|0\\.${OCTET})\\.${OCTET}\\.${OCTET}`;
const HOST_SHAPES: RegExp[] = [
  // Any IPv4 with a port, public or not: a host:port is deployment topology, not a reason.
  new RegExp(`\\b${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}:\\d{1,5}\\b`, "g"),
  new RegExp(`\\b${PRIVATE_V4}\\b`, "g"),
  /\[(?:::1|f[cd][0-9a-f]{2}:[0-9a-f:]*|fe80:[0-9a-f:]*)\](?::\d{1,5})?/gi,
  /\blocalhost(?::\d{1,5})?\b/gi,
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|local|lan|svc|cluster\.local|intranet|corp)(?::\d{1,5})?\b/gi,
  // Docker / compose service name with a port (QA510 P3): `chisabot-postgres:5432`, `redis:6379`.
  // A dotless name counts when it has a - or _ in it, or is a usual service name; a dotted
  // public host is left alone, and so is `12:30` or `error:500`.
  /(?<![\w.:-])[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+:\d{2,5}\b/gi,
  /(?<![\w.:-])(?:postgres(?:ql)?|pg|redis|valkey|mysql|mariadb|mongo(?:db)?|db|database|rabbitmq|amqp|minio|kafka|zookeeper|elasticsearch|opensearch|memcached|nginx|magpie|backend|gateway|api|app|server|worker|web)\d*:\d{2,5}\b/gi,
  // Bare (unbracketed) private / link-local / loopback IPv6 (QA510 P3): fd00::12, fe80::1%eth0, ::1.
  /(?<![\w:])(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):(?::{0,2}[0-9a-f]{1,4}){1,7}(?:%[\w.-]+)?(?![\w:])/gi,
  /(?<![\w:])::1(?![\w:])/g,
];

/** Bare `user:password@host` without a scheme (redactText only parses full URLs). */
const BARE_USERINFO = /(^|[\s(<"'=])[^\s:/@"'<>]+:[^\s@/"'<>]+@(?=[^\s@]+)/g;

/** Redacts already-extracted failure text. Idempotent. */
export function redactPublicText(text: string): string {
  let out = redactUserinfo(redactText(text));
  out = out.replace(BARE_USERINFO, "$1••••:••••@");
  for (const shape of SQL_SHAPES) out = out.replace(shape, SQL_MASK);
  for (const shape of HOST_SHAPES) out = out.replace(shape, HOST_MASK);
  return out.trim();
}

/**
 * What a failure may say outside the process: never a raw `error.message`. Query failures lose
 * their statement and bound values, the rest goes through redactPublicText, and it is capped.
 * A non-Error throw gets `fallback`.
 */
export function publicErrorMessage(
  error: unknown,
  fallback: string = GENERIC_FAILURE,
): string {
  if (!(error instanceof Error)) return fallback;
  const text = redactPublicText(reasonWithoutStatement(error));
  if (!text) return fallback;
  return text.length > PUBLIC_ERROR_MAX
    ? `${text.slice(0, PUBLIC_ERROR_MAX)}…`
    : text;
}

/**
 * The same failure, safe to hand to a stream subscriber or a logger: redacted message, a stack
 * that names only the redacted message, and the routing fields (`name`, `status`, `code`) kept.
 */
export function publicError(error: unknown): Error {
  const safe = new Error(publicErrorMessage(error));
  if (error instanceof Error) {
    safe.name = error.name;
    const fields = error as Error & { status?: unknown; code?: unknown };
    if (typeof fields.status === "number")
      Object.assign(safe, { status: fields.status });
    if (typeof fields.code === "string")
      Object.assign(safe, { code: fields.code });
  }
  safe.stack = `${safe.name}: ${safe.message}`;
  return safe;
}
