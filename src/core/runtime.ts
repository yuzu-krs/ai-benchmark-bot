export const MINIMUM_NODE_VERSION = "24.17.0";

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: boolean;
}

function parseNodeVersion(version: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.+)?$/.exec(version.trim());
  if (!match) return undefined;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] !== undefined
  };
}

export function isSupportedNodeVersion(version: string): boolean {
  const parsed = parseNodeVersion(version);
  const minimum = parseNodeVersion(MINIMUM_NODE_VERSION);
  if (!parsed || !minimum) return false;

  const comparison =
    parsed.major - minimum.major ||
    parsed.minor - minimum.minor ||
    parsed.patch - minimum.patch;

  if (comparison !== 0) return comparison > 0;
  return !parsed.prerelease;
}

export function requireSupportedNodeVersion(version = process.versions.node): void {
  if (!isSupportedNodeVersion(version)) {
    throw new Error(
      `Node.js ${MINIMUM_NODE_VERSION} or newer is required; current version is ${version}`
    );
  }
}
