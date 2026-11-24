import { isIP } from "node:net";
import {
  BlockedUrlError,
  type GuardedFetchOptions,
  guardedFetchStream,
} from "../../../shared/net/guarded-fetch";
import {
  expandIpv6,
  isBlockedAddress,
  isBlockedAddressAllowPrivate,
  isBlockedHostname,
  isBlockedHostnameAllowPrivate,
} from "../../../shared/net/ssrf";
import { withoutRunAssertion } from "../conversations/protocol";

/**
 * Where an external agent lives, and whether we are willing to talk to it.
 *
 * Registering an agent hands us a URL that this server will POST to on every single run. That is a
 * server-side request to an address a user chose,
 * which is the textbook shape of SSRF: without a check, `http://169.254.169.254/` is a registrable
 * "agent" and the runtime will happily fetch cloud credentials on a user's behalf, from inside the
 * deployment, on a schedule.
 *
 * Ordering is the control. Never-allowed ranges (cloud metadata, link-local, CGNAT, 0.0.0.0/8,
 * 6to4, Teredo, embedded IPv4 forms) are refused first from the single canonical table in
 * `shared/net/ssrf.ts`, ahead of any private-host opt-in or named host allowlist. At dial time,
 * {@link createAgentFetch} resolves DNS and pins the verified IP via `guardedFetchStream` on every
 * hop so DNS rebinding and `.nip.io`-style names cannot bypass the string check.
 */

const CLOUD_METADATA_V6: readonly (readonly number[])[] = [
  [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254], // AWS IMDSv2 IPv6 (fd00:ec2::254)
  [0xfd20, 0x00ce, 0, 0, 0, 0, 0, 0x0254], // GCP metadata IPv6 (fd20:ce::254)
];

function sameIpv6(a: readonly number[], b: readonly number[]): boolean {
  return a.length === 8 && b.length === 8 && a.every((v, i) => v === b[i]);
}

function isCloudMetadataIpv6(input: string): boolean {
  const g = expandIpv6(input);
  return g !== null && CLOUD_METADATA_V6.some((meta) => sameIpv6(g, meta));
}

/**
 * An explicitly named IPv6 ULA literal (fc00::/7) that is not a cloud metadata endpoint.
 *
 * `isBlockedAddressAllowPrivate` refuses fc00::/7 wholesale so blanket `allowPrivateHosts` cannot
 * reach cloud IPv6 metadata. When an operator names one exact non-metadata ULA literal such as
 * `[fd00::1:8443]` in `AGENT_ENDPOINT_ALLOWED_HOSTS`, only that exact literal is admitted.
 */
function isNonMetadataUlaLiteral(hostname: string): boolean {
  const bare = hostname.trim().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  if (isIP(bare) !== 6) return false;
  const g = expandIpv6(bare);
  if (!g) return false;
  return ((g[0] ?? 0) & 0xfe00) === 0xfc00 && !isCloudMetadataIpv6(bare);
}

/**
 * Exact match against `allowedHosts` (stored in URL parser spelling, brackets included for IPv6).
 * A host with a port pins that port; a bare host covers its ports.
 */
function isHostAllowed(
  url: URL,
  allowedHosts: ReadonlySet<string> | undefined,
): boolean {
  if (!allowedHosts || allowedHosts.size === 0) return false;
  const hostname = url.hostname.toLowerCase();
  const host = url.port ? `${hostname}:${url.port}` : hostname;
  return allowedHosts.has(host) || allowedHosts.has(hostname);
}

export type EndpointVerdict =
  | { allowed: true; url: string }
  | { allowed: false; reason: string };

/**
 * Check an agent endpoint before it is stored.
 *
 * Refused at registration rather than at run time: a URL that must never be fetched should
 * never reach the database, because everything downstream treats a stored agent as trustworthy.
 */
export function checkAgentEndpoint(
  raw: unknown,
  options: {
    allowPrivateHosts?: boolean;
    allowedHosts?: ReadonlySet<string>;
  } = {},
): EndpointVerdict {
  if (typeof raw !== "string" || !raw.trim()) {
    return { allowed: false, reason: "An agent needs a web address." };
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { allowed: false, reason: "That is not a web address." };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      allowed: false,
      reason: `Only web addresses are allowed, and that one is ${url.protocol.replace(":", "")}.`,
    };
  }

  if (url.username || url.password) {
    return {
      allowed: false,
      reason:
        "An agent address may not include credentials, so an agent may not live there.",
    };
  }

  const named = isHostAllowed(url, options.allowedHosts);
  const allowPrivate = options.allowPrivateHosts === true || named;
  const explicitNonMetadataUla =
    named && isNonMetadataUlaLiteral(url.hostname);

  // Checked before any private opt-in or allowlist so cloud metadata, CGNAT, 0.0.0.0/8, 6to4,
  // Teredo, and embedded-IPv4 spellings can never be named back in.
  if (!explicitNonMetadataUla && isBlockedHostnameAllowPrivate(url.hostname)) {
    return {
      allowed: false,
      reason: "That address is not permitted, so an agent may not live there.",
    };
  }

  if (!allowPrivate && isBlockedHostname(url.hostname)) {
    return {
      allowed: false,
      reason:
        "That address is inside this deployment's own network, so an agent may not live there.",
    };
  }

  return { allowed: true, url: url.toString() };
}

/**
 * How many redirects an agent is allowedbefore we stop believing it has somewhere to be.
 *
 * Three, which covers the ordinary shapes (`http` to `https`, a host rename, a trailing-slash
 * canonicalisation) and stops a chain that has no end.
 */
const MAX_REDIRECTS = 3;

/** An address this deployment will not dial, named so the person registering sees which hop. */
export class EndpointNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointNotAllowedError";
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The headers an AG-UI POST needs to be an AG-UI POST. Everything else on one of these requests is
 * the registered agent's own configuration, which is to say its key.
 */
const PROTOCOL_HEADERS = new Set(["content-type", "accept"]);

/**
 * Whether a hop stays inside the authorisation the request was carrying credentials for.
 *
 * Host and port must match, because a different one is a different party however similar the name.
 * A scheme upgrade is the exception in the permissive direction: `http` to `https` on the same host
 * is the ordinary shape of a deployment behind a redirect, and the credential ends up somewhere
 * strictly better protected than where it started. The downgrade is not the same trade and is
 * treated as a different party.
 */
function sameCredentialScope(from: string, to: string): boolean {
  const a = new URL(from);
  const b = new URL(to);
  if (a.hostname !== b.hostname || a.port !== b.port) return false;
  return (
    a.protocol === b.protocol ||
    (a.protocol === "http:" && b.protocol === "https:")
  );
}

/** The request with everything that proves who we are taken out of it. */
function withoutCredentials(init: RequestInit | undefined): RequestInit {
  const kept = new Headers();
  for (const [name, value] of new Headers(init?.headers)) {
    if (PROTOCOL_HEADERS.has(name.toLowerCase())) kept.set(name, value);
  }
  return { ...init, headers: kept, ...strippedBody(init?.body) };
}

/**
 * The body with this deployment's own signed run taken out of it.
 *
 * The run assertion is a bearer capability: it names the Bot and the person, and whatever holds it
 * can call back and spend that person's grants. Stripping the headers and forwarding the body would
 * leave the more valuable of the two credentials travelling.
 *
 * A body this cannot read is not forwarded at all. A stream or a form is not a shape this deployment
 * sends here, so the choice is between refusing an unreachable case and forwarding something
 * unexamined to a host the request was not authorised for, and only one of those fails safely.
 */
function strippedBody(body: BodyInit | null | undefined): { body?: BodyInit } {
  if (body === null || body === undefined) return {};
  if (typeof body !== "string") {
    throw new EndpointNotAllowedError(
      "That address redirected to another host, and this deployment will not forward the run to it.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not ours to sanitise and not ours to leak. The same reasoning as the non-string case.
    throw new EndpointNotAllowedError(
      "That address redirected to another host, and this deployment will not forward the run to it.",
    );
  }
  if (parsed === null || typeof parsed !== "object") return { body };

  const run = parsed as { forwardedProps?: Record<string, unknown> };
  if (!run.forwardedProps || typeof run.forwardedProps !== "object") {
    return { body };
  }
  const rest = withoutRunAssertion(run.forwardedProps);
  return { body: JSON.stringify({ ...run, forwardedProps: rest }) };
}

/**
 * `fetch`, with the endpoint check applied to every hop rather than only the address a person typed.
 *
 * Checking the URL once and then handing it to a fetch that follows redirects is a check with a hole
 * in it: `https://agent.example.com/ag-ui` passes, answers `307`, and the request lands wherever the
 * `Location` header says, which is how a registrable agent becomes a way to read the deployment's own
 * cloud metadata. The address that gets dialled is the one that must be allowed, and a redirect makes
 * those two different addresses.
 *
 * The stored address is checked too, not only the hops after it. A row written before this guard
 * existed, or under a rule that has since changed, is dialled on every run, and that is the one
 * address a check that only reads `Location` headers never looks at.
 *
 * Redirects are followed rather than refused, because a deployment that puts its agent behind one has
 * done nothing wrong and `http` to `https` is the common case. Each destination goes through
 * {@link checkAgentEndpoint} first, so following one can only ever reach somewhere registering it
 * directly would have been allowed to reach.
 *
 * A hop that leaves the host the request was authorised for arrives with nothing that proves who we
 * are: the customer's key is theirs and was given to us for their host, and the run assertion is
 * this deployment's own capability. Once dropped they stay dropped, so a chain that wanders off and
 * comes back does not collect them again.
 *
 * The method and body are carried across every hop. A browser turns a redirected `POST` into a `GET`;
 * doing that here would only ever produce a confusing "that is not an AG-UI endpoint" from an agent
 * that is one, because AG-UI is a POST protocol and this is a server talking to an API, not a person
 * following a link.
 */
export function createAgentFetch(
  options: {
    allowPrivateHosts?: boolean;
    /**
     * Carried to every hop, not only the first. An address the deployment named is reachable
     * wherever it appears, and one it did not name is refused wherever it appears — a redirect must
     * not be a way to arrive somewhere registration would have declined.
     */
    allowedHosts?: ReadonlySet<string>;
    fetchImpl?: typeof fetch;
    /** Injectable DNS resolver for tests; production resolves through Node DNS and pins the IP. */
    resolve?: GuardedFetchOptions["resolve"];
    /**
     * Told about every address this refused to dial, and why.
     *
     * A refusal is the one thing on this path an operator cannot otherwise learn. The person who
     * registered the agent finds out immediately, because their run fails and says why; the
     * deployment finds out nothing, and a stored agent that has quietly begun redirecting to the
     * metadata address is precisely the event worth being able to count.
     *
     * A callback rather than an audit store, so this module keeps deciding and nothing else.
     *
     * Reporting must never be able to stop a refusal, so a throwing reporter is swallowed. The
     * refusal is the security property and the row is the record of it; losing the record is bad and
     * turning it into a dialled request would be worse.
     */
    onRefusal?: (refusal: { address: string; reason: string }) => void;
  } = {},
): (url: string, init?: RequestInit) => Promise<Response> {
  const refuse = (address: string, reason: string) => {
    try {
      options.onRefusal?.({ address, reason });
    } catch {
      // See above: a reporter that throws must not become a request that succeeds.
    }
    return new EndpointNotAllowedError(reason);
  };
  const check = (address: string) =>
    checkAgentEndpoint(address, {
      ...(options.allowPrivateHosts !== undefined
        ? { allowPrivateHosts: options.allowPrivateHosts }
        : {}),
      ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}),
    });

  const dialHop = async (
    target: string,
    init: RequestInit | undefined,
    hop: number,
  ): Promise<Response> => {
    if (options.fetchImpl) {
      return options.fetchImpl(target, {
        ...init,
        redirect: "manual",
      });
    }
    const parsed = new URL(target);
    const named = isHostAllowed(parsed, options.allowedHosts);
    const allowPrivate = options.allowPrivateHosts === true || named;
    const explicitNonMetadataUla =
      named && isNonMetadataUlaLiteral(parsed.hostname);
    const targetV6 = explicitNonMetadataUla
      ? expandIpv6(parsed.hostname)
      : null;
    const isBlocked =
      explicitNonMetadataUla && targetV6
        ? (address: string) => {
            const candidate = expandIpv6(address);
            if (candidate && sameIpv6(candidate, targetV6)) return false;
            return isBlockedAddressAllowPrivate(address);
          }
        : allowPrivate
          ? isBlockedAddressAllowPrivate
          : isBlockedAddress;

    const headers: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value;
      });
    }

    try {
      return await guardedFetchStream(target, {
        method: init?.method ?? "GET",
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(init?.body !== undefined ? { body: init.body } : {}),
        ...(init?.signal ? { signal: init.signal } : {}),
        allowPrivate,
        isBlocked,
        ...(options.resolve ? { resolve: options.resolve } : {}),
      });
    } catch (error) {
      if (error instanceof BlockedUrlError) {
        throw refuse(
          target,
          hop === 0
            ? `This deployment will not dial ${target}: that address resolved to a restricted network destination, so an agent may not live there.`
            : `That address redirected to ${target}, and that address resolved to a restricted network destination, so an agent may not live there.`,
        );
      }
      throw error;
    }
  };

  return async function guardedAgentFetch(url: string, init?: RequestInit) {
    const stored = check(url);
    if (!stored.allowed) {
      throw refuse(
        url,
        `This deployment will not dial ${url}: ${stored.reason.charAt(0).toLowerCase()}${stored.reason.slice(1)}`,
      );
    }

    const origin = stored.url;
    let target = stored.url;
    let carried = init;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      // `manual` is what makes this a check rather than a comment: the caller sees the redirect, and
      // the underlying fetch cannot quietly follow one on its own.
      const response = await dialHop(target, carried, hop);
      if (!REDIRECT_STATUSES.has(response.status)) return response;

      const location = response.headers.get("location");
      // A redirect status with nowhere to go is just an answer. Whatever it means, it is the
      // agent's own reply and not a hop.
      if (!location) return response;

      await response.body?.cancel().catch(() => undefined);

      const next = new URL(location, target).toString();
      const verdict = check(next);
      if (!verdict.allowed) {
        throw refuse(
          next,
          `That address redirected to ${next}, and ${verdict.reason.charAt(0).toLowerCase()}${verdict.reason.slice(1)}`,
        );
      }
      if (!sameCredentialScope(origin, verdict.url)) {
        // A body this cannot strip refuses the hop rather than forwarding it, and that refusal is
        // worth the same row as any other: it means a run was carrying something unreadable to a
        // host it was not authorised for.
        try {
          carried = withoutCredentials(carried);
        } catch (error) {
          throw refuse(
            verdict.url,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      target = verdict.url;
    }

    // Counted with the rest. An agent that loops is not a trust decision, but it is an endpoint
    // failing in a way only the trail can show is happening repeatedly.
    throw refuse(
      target,
      `That address redirected more than ${MAX_REDIRECTS} times without arriving anywhere.`,
    );
  };
}
