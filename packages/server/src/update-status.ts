import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultPackageJsonPath = path.resolve(__dirname, "../../../package.json");
const DEFAULT_PACKAGE_NAME = "roughdraft";

interface PackageManifest {
  name?: string;
  version?: string;
}

interface ParsedVersion {
  parts: number[];
  prerelease: string[];
}

export interface UpdateStatus {
  packageName: string;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  updateCommand: string;
}

interface ResolveUpdateStatusOptions {
  fetchImpl?: typeof fetch;
  packageJsonPath?: string;
  packageName?: string;
}

function readInstalledPackageInfo(packageJsonPath = defaultPackageJsonPath): {
  packageName: string;
  currentVersion: string | null;
} {
  try {
    const raw = fs.readFileSync(packageJsonPath, "utf8");
    const manifest = JSON.parse(raw) as PackageManifest;
    return {
      packageName: manifest.name?.trim() || DEFAULT_PACKAGE_NAME,
      currentVersion: manifest.version?.trim() || null,
    };
  } catch {
    return {
      packageName: DEFAULT_PACKAGE_NAME,
      currentVersion: null,
    };
  }
}

function parseVersion(version: string): ParsedVersion {
  const normalizedVersion = version.trim().replace(/^v/i, "");
  const [mainVersion, prereleaseVersion = ""] = normalizedVersion.split("-", 2);
  const parts = mainVersion
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isNaN(part) ? 0 : part));

  const prerelease = prereleaseVersion
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);

  return { parts, prerelease };
}

function comparePrerelease(left: string[], right: string[]) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];

    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumber = Number.parseInt(leftPart, 10);
    const rightNumber = Number.parseInt(rightPart, 10);
    const leftIsNumeric = /^[0-9]+$/.test(leftPart);
    const rightIsNumeric = /^[0-9]+$/.test(rightPart);

    if (leftIsNumeric && rightIsNumeric) {
      if (leftNumber !== rightNumber) {
        return leftNumber < rightNumber ? -1 : 1;
      }
      continue;
    }

    if (leftIsNumeric !== rightIsNumeric) {
      return leftIsNumeric ? -1 : 1;
    }

    return leftPart.localeCompare(rightPart);
  }

  return 0;
}

export function compareVersions(leftVersion: string, rightVersion: string) {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  const length = Math.max(left.parts.length, right.parts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = left.parts[index] ?? 0;
    const rightPart = right.parts[index] ?? 0;

    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }

  return comparePrerelease(left.prerelease, right.prerelease);
}

export const FORK_UPDATE_COMMAND =
  'git pull && pnpm install && pnpm build && npm i -g "$(npm pack --silent)" (from your roughdraftplus clone)';

// This build installs from a local clone of kudzuweb/roughdraftplus, never
// from the npm registry: the registry's `roughdraft` package is the
// unmaintained upstream lineage, so a registry version comparison would
// prompt users to overwrite the fork with upstream's copy. Update status
// therefore never consults the registry and never reports an update.
export async function resolveUpdateStatus(
  options: ResolveUpdateStatusOptions = {},
): Promise<UpdateStatus> {
  const installedPackageInfo = readInstalledPackageInfo(
    options.packageJsonPath,
  );
  const packageName =
    options.packageName?.trim() || installedPackageInfo.packageName;

  return {
    packageName,
    currentVersion: installedPackageInfo.currentVersion,
    latestVersion: null,
    updateAvailable: false,
    updateCommand: FORK_UPDATE_COMMAND,
  };
}
