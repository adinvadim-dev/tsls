import { isIP } from "node:net";
import { hostname } from "node:os";
import { record } from "./config.js";
import { type FailureCode, type Host, ProbeError } from "./model.js";
import { execute } from "./process.js";
import { resolveAliases, safeAlias } from "./ssh-config.js";

export const MAX_PROBES = 32;
export const SNAPSHOT_MS = 30000;
export type Peer = {
  id: string;
  name: string;
  os: string | null;
  online: boolean | null;
  lastSeen: string | null;
  destinations: string[];
};
export type Item = {
  host: Host;
  peer: Peer | null;
  skip: { code: FailureCode; message: string } | null;
};
export type Discovery = {
  source: "local" | "tailscale" | "config";
  status: "ok" | "unavailable" | "invalid";
  message: string | null;
  aliasesLimited: boolean;
  duplicatesIgnored: number;
};
export function labelName(name: string): string {
  const label =
    name
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/^[^a-zA-Z0-9]+/, "")
      .slice(0, 64) || "host";
  return label === "init" ? "init-host" : label;
}
const normalized = (name: string): string =>
  name.toLowerCase().replace(/\.$/, "");
function parsePeer(value: unknown): Peer {
  if (
    !record(value) ||
    typeof value.ID !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(value.ID)
  )
    throw new Error("Invalid Tailscale node ID");
  const dns =
    typeof value.DNSName === "string" ? normalized(value.DNSName) : "";
  const hostName = typeof value.HostName === "string" ? value.HostName : "";
  const name = hostName || dns.split(".")[0] || value.ID;
  const ips = Array.isArray(value.TailscaleIPs)
    ? value.TailscaleIPs.filter(
        (ip): ip is string => typeof ip === "string" && isIP(ip) !== 0,
      )
    : [];
  return {
    id: value.ID,
    name: labelName(name),
    os: typeof value.OS === "string" ? value.OS : null,
    online: typeof value.Online === "boolean" ? value.Online : null,
    lastSeen:
      typeof value.LastSeen === "string" &&
      Number.isFinite(Date.parse(value.LastSeen))
        ? value.LastSeen
        : null,
    destinations: [
      ...new Set(
        [dns, ...ips, normalized(hostName)].filter(
          (s) => safeAlias(s) || isIP(s) !== 0,
        ),
      ),
    ],
  };
}
export function parseStatus(input: unknown): {
  self: Peer;
  peers: Peer[];
  duplicatesIgnored: number;
} {
  if (
    !record(input) ||
    input.BackendState !== "Running" ||
    (input.Peer !== null && !record(input.Peer))
  )
    throw new Error("Tailscale is not running or status is incomplete");
  const self = parsePeer(input.Self);
  const seen = new Set([self.id]);
  let duplicatesIgnored = 0;
  const peers: Peer[] = [];
  for (const value of Object.values(input.Peer ?? {})) {
    const peer = parsePeer(value);
    if (seen.has(peer.id)) {
      duplicatesIgnored++;
      continue;
    }
    seen.add(peer.id);
    peers.push(peer);
  }
  // A short hostname can name several nodes. Never attach one destination's
  // readings to multiple peer IDs, including when malformed status repeats DNS/IP.
  const destinationCounts = new Map<string, number>();
  for (const peer of [self, ...peers])
    for (const destination of peer.destinations)
      destinationCounts.set(
        destination,
        (destinationCounts.get(destination) ?? 0) + 1,
      );
  for (const peer of [self, ...peers])
    peer.destinations = peer.destinations.filter(
      (destination) => destinationCounts.get(destination) === 1,
    );
  return {
    self,
    peers: peers.sort((a, b) => a.id.localeCompare(b.id)),
    duplicatesIgnored,
  };
}
export async function discover(
  signal: AbortSignal,
): Promise<{ items: Item[]; discovery: Discovery }> {
  const local: Item = {
    host: { label: labelName(hostname()), transport: "local" },
    peer: null,
    skip: null,
  };
  let status: ReturnType<typeof parseStatus>;
  try {
    const result = await execute({
      command: "tailscale",
      args: ["status", "--json"],
      signal,
      timeoutMs: 3000,
      maxBytes: 4 * 1024 * 1024,
    });
    if (result.code !== 0)
      return {
        items: [local],
        discovery: {
          source: "local",
          status: "unavailable",
          message: "Tailscale status unavailable; showing local metrics only",
          aliasesLimited: false,
          duplicatesIgnored: 0,
        },
      };
    const input: unknown = JSON.parse(result.stdout);
    if (
      record(input) &&
      typeof input.BackendState === "string" &&
      input.BackendState !== "Running"
    )
      return {
        items: [local],
        discovery: {
          source: "local",
          status: "unavailable",
          message: "Tailscale is not running; showing local metrics only",
          aliasesLimited: false,
          duplicatesIgnored: 0,
        },
      };
    status = parseStatus(input);
  } catch (error) {
    const invalid =
      error instanceof SyntaxError ||
      (error instanceof Error && !("code" in error));
    return {
      items: [local],
      discovery: {
        source: "local",
        status: invalid ? "invalid" : "unavailable",
        message: invalid
          ? "Invalid or incomplete Tailscale JSON; showing local metrics only"
          : error instanceof ProbeError && error.code === "timeout"
            ? "Tailscale status timed out; showing local metrics only"
            : error instanceof ProbeError && error.code === "probe"
              ? "Tailscale status exceeded its output limit; showing local metrics only"
              : "Tailscale command unavailable; showing local metrics only",
        aliasesLimited: false,
        duplicatesIgnored: 0,
      },
    };
  }
  local.host.label = status.self.name;
  local.peer = status.self;
  const items: Item[] = [local];
  const labels = new Set([local.host.label]);
  for (const peer of status.peers) {
    let label = peer.name;
    if (labels.has(label))
      label = `${label.slice(0, 45)}-${peer.id}`.slice(0, 64);
    let suffix = 2;
    while (labels.has(label)) label = `${peer.name.slice(0, 45)}-${suffix++}`;
    labels.add(label);
    const target = peer.destinations[0];
    const skip: Item["skip"] =
      !peer.os || !/^(linux|macos|darwin)$/i.test(peer.os)
        ? { code: "unsupported_os", message: "OS is unknown or unsupported" }
        : peer.online !== true
          ? {
              code: "offline_peer",
              message: "Peer is offline or online state is unknown",
            }
          : !target
            ? {
                code: "invalid_target",
                message: "Peer has no safe SSH destination",
              }
            : null;
    items.push({
      host: { label, transport: "ssh", target: target ?? "invalid" },
      peer,
      skip,
    });
  }
  let aliasesLimited = false;
  if (items.some((item) => !item.skip && item.host.transport === "ssh")) {
    const resolved = await resolveAliases(signal);
    aliasesLimited = resolved.limited;
    for (const item of items) {
      if (item.skip || !item.peer || item.host.transport !== "ssh") continue;
      const alias = resolved.aliases.find((candidate) =>
        item.peer?.destinations.includes(normalized(candidate.hostname)),
      );
      if (alias) item.host.target = alias.alias;
    }
  }
  return {
    items,
    discovery: {
      source: "tailscale",
      status: "ok",
      message: aliasesLimited
        ? "SSH alias resolution was bounded; unmatched peers use OpenSSH destination defaults"
        : null,
      aliasesLimited,
      duplicatesIgnored: status.duplicatesIgnored,
    },
  };
}
