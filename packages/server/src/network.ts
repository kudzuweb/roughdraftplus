export { ROUGHDRAFT_DEFAULT_PORT } from "../defaults.mjs";
export const ROUGHDRAFT_BIND_HOST = "127.0.0.1";
export const ROUGHDRAFT_LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;
export const ROUGHDRAFT_PUBLIC_HOST = "localhost";

export const ROUGHDRAFT_BIND_HOST_ENV = "ROUGHDRAFT_BIND_HOST";
export const ROUGHDRAFT_TOKEN_ENV = "ROUGHDRAFT_TOKEN";

export function configuredToken(env: NodeJS.ProcessEnv): string {
  const token = env[ROUGHDRAFT_TOKEN_ENV];
  return typeof token === "string" ? token.trim() : "";
}

// A server bound to a non-loopback address requires this token on every route
// that reads or writes a file, so every client attaches it to those requests
// whenever it holds one. On the loopback default the server ignores it, which
// keeps one code path for both binds.
export function tokenAuthHeaders(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const token = configuredToken(env);
  return token.length > 0 ? { Authorization: `Bearer ${token}` } : {};
}

const LOOPBACK_HOST_NAMES = new Set<string>([
  ...ROUGHDRAFT_LOOPBACK_HOSTS,
  "localhost",
]);

export function resolveBindHosts(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const raw = env[ROUGHDRAFT_BIND_HOST_ENV];

  if (raw === undefined) {
    return ROUGHDRAFT_LOOPBACK_HOSTS;
  }

  const hosts = raw
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);

  if (hosts.length === 0) {
    return ROUGHDRAFT_LOOPBACK_HOSTS;
  }

  return hosts;
}

export function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOST_NAMES.has(host)) return true;
  // Any address in 127.0.0.0/8 is loopback (RFC 5735).
  if (host.startsWith("127.")) return true;
  return false;
}

export function hasNonLoopbackHost(hosts: readonly string[]): boolean {
  return hosts.some((host) => !isLoopbackHost(host));
}
