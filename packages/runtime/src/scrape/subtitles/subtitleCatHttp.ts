import type { RuntimeNetworkClient, RuntimeRequestInit } from "../../network";
import { isAbortError, throwIfAborted } from "../utils/abort";
import { SubtitleCatProviderError, SubtitleCatResponseTooBigError } from "./errors";
import { validateSubtitleCatUrl } from "./subtitleCatUrl";

/** HTML pages: 2 MiB, same ceiling as the Go reference's `pageLimit`. */
export const SUBTITLE_CAT_PAGE_LIMIT = 2 << 20;
/** Subtitle files: 8 MiB, same ceiling as the Go reference's `fileLimit`. */
export const SUBTITLE_CAT_FILE_LIMIT = 8 << 20;

const MAX_ATTEMPTS = 3;
const USER_AGENT = "Mozilla/5.0 (compatible; FlixSubtitle/1.0)";
const ACCEPT = "text/html,application/xhtml+xml,text/plain,*/*;q=0.8";
const HTTP_STATUS_PATTERN = /\bHTTP (\d{3})\b/u;

/**
 * The slice of the runtime network client this module needs. `probe` and `getContent` stay optional so
 * tests can hand over a two-method fake.
 */
export interface SubtitleCatNetworkClient {
  getText: RuntimeNetworkClient["getText"];
  getContent?: RuntimeNetworkClient["getContent"];
  probe?: RuntimeNetworkClient["probe"];
}

export interface SubtitleCatFetchOptions {
  base: URL;
  maxBytes: number;
  referer?: string;
  signal?: AbortSignal;
  timeout?: number;
}

const buildRequestInit = (options: SubtitleCatFetchOptions): RuntimeRequestInit => ({
  headers: {
    accept: ACCEPT,
    "user-agent": USER_AGENT,
    ...(options.referer ? { referer: options.referer } : {}),
  },
  signal: options.signal,
  timeout: options.timeout,
});

/**
 * `NetworkClient` throws a formatted `HTTP <status> ...` message rather than handing back a response,
 * so the status has to be recovered from the message to tell a retryable 5xx from a fatal 4xx.
 */
const parseHttpStatus = (error: unknown): number | undefined => {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const matched = HTTP_STATUS_PATTERN.exec(error.message);
  return matched ? Number.parseInt(matched[1], 10) : undefined;
};

const isRetryable = (error: unknown): boolean => {
  if (isAbortError(error) || error instanceof SubtitleCatResponseTooBigError) {
    return false;
  }

  const status = parseHttpStatus(error);
  // Transport failures carry no status and are always worth another attempt; a 4xx never is.
  return status === undefined || status >= 500 || status === 429;
};

/**
 * Pre-flights `content-length` so an oversized file is refused before it is buffered. Only worth the
 * extra round trip for the subtitle download; HTML pages are cheap and are size-checked after the fact.
 */
const assertAdvertisedSizeWithinLimit = async (
  client: SubtitleCatNetworkClient,
  url: URL,
  options: SubtitleCatFetchOptions,
): Promise<void> => {
  if (!client.probe) {
    return;
  }

  const probed = await client.probe(url.toString(), buildRequestInit(options)).catch(() => undefined);
  const contentLength = probed?.contentLength ?? null;
  if (contentLength !== null && contentLength > options.maxBytes) {
    throw new SubtitleCatResponseTooBigError(url.toString(), options.maxBytes);
  }
};

const runWithRetries = async <T>(url: URL, attempt: (attemptIndex: number) => Promise<T>): Promise<T> => {
  let lastError: unknown;

  for (let attemptIndex = 0; attemptIndex < MAX_ATTEMPTS; attemptIndex += 1) {
    try {
      return await attempt(attemptIndex);
    } catch (error) {
      if (!isRetryable(error)) {
        throw error;
      }
      lastError = error;
    }
  }

  throw new SubtitleCatProviderError(
    `${url.toString()} failed after ${MAX_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
};

/** Ports Go's `get` for HTML pages: validate, up to 3 attempts, then enforce the byte ceiling. */
export const fetchLimitedText = async (
  client: SubtitleCatNetworkClient,
  url: URL,
  options: SubtitleCatFetchOptions,
): Promise<string> => {
  validateSubtitleCatUrl(options.base, url);
  throwIfAborted(options.signal);

  return runWithRetries(url, async () => {
    throwIfAborted(options.signal);
    const text = await client.getText(url.toString(), buildRequestInit(options));
    if (Buffer.byteLength(text, "utf8") > options.maxBytes) {
      throw new SubtitleCatResponseTooBigError(url.toString(), options.maxBytes);
    }

    return text;
  });
};

/** Ports Go's `get` for the subtitle file itself. */
export const fetchLimitedContent = async (
  client: SubtitleCatNetworkClient,
  url: URL,
  options: SubtitleCatFetchOptions,
): Promise<Buffer> => {
  validateSubtitleCatUrl(options.base, url);
  throwIfAborted(options.signal);

  const getContent = client.getContent;
  if (!getContent) {
    throw new SubtitleCatProviderError("network client cannot download binary content");
  }

  return runWithRetries(url, async (attemptIndex) => {
    throwIfAborted(options.signal);
    if (attemptIndex === 0) {
      await assertAdvertisedSizeWithinLimit(client, url, options);
    }
    const bytes = await getContent.call(client, url.toString(), buildRequestInit(options));
    if (bytes.byteLength > options.maxBytes) {
      throw new SubtitleCatResponseTooBigError(url.toString(), options.maxBytes);
    }

    return Buffer.from(bytes);
  });
};
