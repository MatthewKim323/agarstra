import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { RequestHandler } from "express";
import { AppError } from "./errors";

export function localhostGuard(ports: number[] = [4317, 4318]): RequestHandler {
  const hosts = new Set(
    ports.flatMap((port) => [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
    ]),
  );
  const origins = new Set([...hosts].map((host) => `http://${host}`));
  return (req, res, next) => {
    const origin = req.headers.origin;
    const site = req.headers["sec-fetch-site"];
    if (
      !hosts.has(req.headers.host ?? "") ||
      (origin && !origins.has(origin)) ||
      site === "cross-site"
    ) {
      res
        .status(403)
        .json({
          error: "Only the local Nerve application may access this bridge.",
        });
      return;
    }
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !req.is("application/json")
    ) {
      res.status(415).json({ error: "Requests must use application/json." });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  };
}

/** Deny non-global address space, including encoded IPv4 and IPv4-mapped IPv6. */
export function isPublicAddress(address: string): boolean {
  const value = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(value) === 4) {
    const [a, b, c] = value.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Only ordinary global-unicast IPv6 is accepted. Transition/tunnel/documentation ranges are not.
  if (isIP(value) === 6) {
    const [first, second] = value
      .split(":")
      .map((part) => parseInt(part || "0", 16));
    return (
      first >= 0x2000 &&
      first <= 0x3fff &&
      first !== 0x2002 &&
      first !== 0x3fff &&
      !(first === 0x2001 && (second <= 0x01ff || second === 0x0db8))
    );
  }
  return false;
}

export type NetworkPolicy = {
  origin: string;
  local: boolean;
  hostname: string;
  pinnedAddress?: string;
};
export type ResolveHost = (
  host: string,
) => Promise<{ address: string; family: number }[]>;

export async function createNetworkPolicy(
  rawUrl: string,
  localOrigin: string,
  resolver: ResolveHost = (host) => lookup(host, { all: true, verbatim: true }),
): Promise<NetworkPolicy> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError(400, "Enter a valid HTTPS website address.");
  }
  if (url.username || url.password)
    throw new AppError(400, "Website addresses cannot contain credentials.");
  if (
    url.origin === localOrigin &&
    (url.pathname === "/lab" || url.pathname.startsWith("/lab/"))
  ) {
    return { origin: localOrigin, local: true, hostname: url.hostname };
  }
  if (url.protocol !== "https:" || (url.port && url.port !== "443"))
    throw new AppError(
      400,
      "External sessions require HTTPS on the default port.",
    );
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname.includes(".") && !isIP(hostname))
    throw new AppError(400, "Local and internal destinations are not allowed.");
  if (
    /\.(localhost|local|internal|home|lan|test|invalid)$/.test(hostname) ||
    hostname === "localhost"
  ) {
    throw new AppError(400, "Local and internal destinations are not allowed.");
  }
  let addresses: { address: string; family: number }[];
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await resolver(hostname);
  } catch {
    throw new AppError(400, "The website address could not be resolved.");
  }
  if (
    !addresses.length ||
    addresses.some((item) => !isPublicAddress(item.address))
  ) {
    throw new AppError(
      400,
      "Local, private, and reserved network destinations are blocked.",
    );
  }
  return {
    origin: url.origin,
    local: false,
    hostname,
    pinnedAddress:
      addresses.find((item) => item.family === 4)?.address ??
      addresses[0].address,
  };
}

export function isAllowedRequest(
  rawUrl: string,
  policy: NetworkPolicy,
): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password || url.origin !== policy.origin)
      return false;
    return policy.local
      ? url.pathname === "/lab" || url.pathname.startsWith("/lab/")
      : url.protocol === "https:";
  } catch {
    return false;
  }
}
