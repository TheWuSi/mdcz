import { isIP } from "node:net";
import { SubtitleCatUnsafeUrlError } from "./errors";

export const SUBTITLE_CAT_HOST = "www.subtitlecat.com";
export const SUBTITLE_CAT_BASE_URL = `https://${SUBTITLE_CAT_HOST}/`;

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/iu;
const LOCAL_HOST_NAMES = new Set(["localhost", "localhost.localdomain"]);

const parseIpv4Octets = (host: string): number[] | undefined => {
  if (isIP(host) !== 4) {
    return undefined;
  }

  return host.split(".").map((part) => Number.parseInt(part, 10));
};

/** Mirrors Go's `unsafeIP` for v4: unspecified, loopback, RFC1918, link-local, multicast/reserved. */
const isUnsafeIpv4 = (octets: readonly number[]): boolean => {
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 127 ||
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254) ||
    first >= 224
  );
};

const expandIpv6Groups = (address: string): number[] | undefined => {
  const [withoutZone] = address.split("%");
  const compressedParts = withoutZone.split("::");
  if (compressedParts.length > 2) {
    return undefined;
  }

  const parseGroups = (segment: string): number[] | undefined => {
    if (!segment) {
      return [];
    }

    const parts = segment.split(":");
    const groups: number[] = [];
    for (const [index, part] of parts.entries()) {
      // Only the final component may be a dotted IPv4 tail (`::ffff:127.0.0.1`), worth two groups.
      if (part.includes(".")) {
        const octets = index === parts.length - 1 ? parseIpv4Octets(part) : undefined;
        if (!octets) {
          return undefined;
        }
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }

      const value = Number.parseInt(part, 16);
      if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
        return undefined;
      }
      groups.push(value);
    }

    return groups;
  };

  const head = parseGroups(compressedParts[0]);
  const tail = compressedParts.length === 2 ? parseGroups(compressedParts[1]) : [];
  if (!head || !tail) {
    return undefined;
  }

  if (compressedParts.length === 1) {
    return head.length === 8 ? head : undefined;
  }

  const zeroFill = 8 - head.length - tail.length;
  return zeroFill < 0 ? undefined : [...head, ...Array.from({ length: zeroFill }, () => 0), ...tail];
};

/** Mirrors Go's `unsafeIP` for v6: unspecified, loopback, link-local, multicast, unique-local. */
const isUnsafeIpv6Groups = (groups: readonly number[]): boolean => {
  const isIpv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const isIpv4Compatible = groups.slice(0, 6).every((group) => group === 0);
  // `::`, `::1` and `::ffff:10.0.0.1` all reduce to the v4 rules, which already cover
  // unspecified and loopback.
  if (isIpv4Mapped || isIpv4Compatible) {
    return isUnsafeIpv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  }

  const linkLocal = (groups[0] & 0xffc0) === 0xfe80;
  const multicast = (groups[0] & 0xff00) === 0xff00;
  const uniqueLocal = (groups[0] & 0xfe00) === 0xfc00;
  return linkLocal || multicast || uniqueLocal;
};

/**
 * Rejects hosts that would let a tampered page pull us onto the local network. Literal addresses are
 * range-checked here; DNS names cannot be checked without resolving, which the network layer owns.
 */
export const isUnsafeSubtitleCatHost = (host: string): boolean => {
  const normalized = host.trim().toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
  if (!normalized) {
    return true;
  }

  if (LOCAL_HOST_NAMES.has(normalized) || normalized.endsWith(".localhost")) {
    return true;
  }

  const ipv4Octets = parseIpv4Octets(normalized);
  if (ipv4Octets) {
    return isUnsafeIpv4(ipv4Octets);
  }

  if (isIP(normalized) === 6) {
    const groups = expandIpv6Groups(normalized);
    return groups ? isUnsafeIpv6Groups(groups) : true;
  }

  return false;
};

/**
 * Ports Go's `validateURL`: a resolved URL must stay on the base origin, carry no credentials and
 * never downgrade the scheme.
 */
export const validateSubtitleCatUrl = (base: URL, target: URL): void => {
  if (target.username || target.password) {
    throw new SubtitleCatUnsafeUrlError(`URL carries credentials: ${target.host}`);
  }

  if (target.protocol !== base.protocol) {
    throw new SubtitleCatUnsafeUrlError(`scheme ${target.protocol} does not match ${base.protocol}`);
  }

  if (target.hostname.toLowerCase() !== base.hostname.toLowerCase()) {
    throw new SubtitleCatUnsafeUrlError(`host ${target.hostname} does not match ${base.hostname}`);
  }

  if (isUnsafeSubtitleCatHost(target.hostname)) {
    throw new SubtitleCatUnsafeUrlError(`host resolves to a private address: ${target.hostname}`);
  }
};

/**
 * Ports Go's `resolve`: turns a site-relative href from a scraped page into an absolute URL, refusing
 * anything that could redirect us off-site or traverse out of the site root.
 */
export const resolveSubtitleCatUrl = (baseUrl: string | URL, reference: string): URL => {
  const trimmed = reference.trim();
  if (!trimmed) {
    throw new SubtitleCatUnsafeUrlError("empty reference");
  }

  if (trimmed.includes("\\")) {
    throw new SubtitleCatUnsafeUrlError(`backslash in reference: ${trimmed}`);
  }

  if (SCHEME_PATTERN.test(trimmed)) {
    throw new SubtitleCatUnsafeUrlError(`absolute reference: ${trimmed}`);
  }

  // `//evil.example/x` would silently swap the authority when resolved against the base.
  if (trimmed.startsWith("//")) {
    throw new SubtitleCatUnsafeUrlError(`protocol-relative reference: ${trimmed}`);
  }

  const [pathPortion] = trimmed.split(/[?#]/u);
  for (const segment of pathPortion.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new SubtitleCatUnsafeUrlError(`undecodable path segment in ${trimmed}`);
    }

    if (decoded === "." || decoded === "..") {
      throw new SubtitleCatUnsafeUrlError(`path traversal in reference: ${trimmed}`);
    }
  }

  const base = new URL(baseUrl);
  let target: URL;
  try {
    target = new URL(trimmed, base);
  } catch {
    throw new SubtitleCatUnsafeUrlError(`unparsable reference: ${trimmed}`);
  }

  validateSubtitleCatUrl(base, target);
  return target;
};

/** Builds the search URL the same way Go does: `index.php?search=<trimmed number>`. */
export const buildSubtitleCatSearchUrl = (baseUrl: string | URL, number: string): URL =>
  resolveSubtitleCatUrl(baseUrl, `index.php?search=${encodeURIComponent(number.trim())}`);
