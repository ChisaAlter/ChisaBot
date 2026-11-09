import { readCompatibleHeader } from "./legacy-headers";

/** Compare the caller's Bot token without leaking its contents through timing. */
export function matchesToken(expected: string, offered: string): boolean {
  if (expected.length === 0 || offered.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < offered.length; index += 1) {
    difference |= offered.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

/** The one header accepted from ChisaBot's server when it calls a managed Bot. */
export function hasManagedAgentToken(
  request: Request,
  expected: string,
): boolean {
  return matchesToken(
    expected,
    readCompatibleHeader(request.headers, "x-chisabot-agent-token")?.trim() ?? "",
  );
}
