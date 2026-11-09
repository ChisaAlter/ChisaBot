/** Only the desktop shell's closed metadata may join the runtime's existing events. */
export function desktopTelemetryProperties(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (env.CHISABOT_DISTRIBUTION !== "desktop") return {};

  const properties: Record<string, string> = {
    chisabot_distribution: "desktop",
  };
  for (const [input, output, allowed] of [
    [
      "CHISABOT_PLATFORM",
      "chisabot_platform",
      ["macos", "windows", "linux", "other"],
    ],
    ["CHISABOT_ARCH", "chisabot_arch", ["aarch64", "x86_64", "other"]],
    ["CHISABOT_ENGINE", "chisabot_engine", ["docker", "podman", "none"]],
  ] as const) {
    const value = env[input];
    if (value && allowed.some((item) => item === value))
      properties[output] = value;
  }
  for (const [input, output] of [
    ["CHISABOT_VERSION", "chisabot_version"],
    ["CHISABOT_OS_VERSION", "chisabot_os_version"],
  ] as const) {
    const value = env[input];
    if (
      value &&
      value.length <= 32 &&
      value.trim() === value &&
      /^\d+(?:\.\d+){1,3}$/.test(value)
    ) {
      properties[output] = value;
    }
  }
  return properties;
}
