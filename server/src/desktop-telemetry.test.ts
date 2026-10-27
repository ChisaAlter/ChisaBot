import { describe, expect, test } from "bun:test";
import { desktopTelemetryProperties } from "./desktop-telemetry";

describe("desktop runtime metadata", () => {
  test("leaves ordinary server deployments untagged", () => {
    expect(desktopTelemetryProperties({})).toEqual({});
    expect(
      desktopTelemetryProperties({ CHISABOT_DISTRIBUTION: "server" }),
    ).toEqual({});
  });

  test("carries only the shell's bounded metadata", () => {
    expect(
      desktopTelemetryProperties({
        CHISABOT_DISTRIBUTION: "desktop",
        CHISABOT_VERSION: "0.0.9",
        CHISABOT_PLATFORM: "macos",
        CHISABOT_ARCH: "aarch64",
        CHISABOT_OS_VERSION: "15.6.1",
        CHISABOT_ENGINE: "podman",
        OPENAI_API_KEY: "synthetic-secret",
        CPK_TELEMETRY_ID: "identity-belongs-in-the-transport",
        HOME: "/Users/private-name",
        CHISABOT_BASE_URL: "https://private.example",
      }),
    ).toEqual({
      openbot_distribution: "desktop",
      openbot_version: "0.0.9",
      openbot_platform: "macos",
      openbot_arch: "aarch64",
      openbot_os_version: "15.6.1",
      openbot_engine: "podman",
    });
  });

  test.each([
    "/Users/private-name",
    "private.example",
    "1.2-private-name",
    "1.2\nsecret",
    "1.2\n",
    "1.2.3.4.5",
    "1".repeat(40),
  ])("rejects arbitrary text in every metadata field: %s", (value) => {
    expect(
      desktopTelemetryProperties({
        CHISABOT_DISTRIBUTION: "desktop",
        CHISABOT_VERSION: value,
        CHISABOT_OS_VERSION: value,
        CHISABOT_PLATFORM: value,
        CHISABOT_ARCH: value,
        CHISABOT_ENGINE: value,
      }),
    ).toEqual({ openbot_distribution: "desktop" });
  });
});
