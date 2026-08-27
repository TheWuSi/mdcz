/** Every failure raised by the SubtitleCat client, so callers can degrade gracefully in one catch. */
export class SubtitleCatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubtitleCatError";
  }
}

/** A URL escaped the provider's own origin, or pointed at a private/loopback address. */
export class SubtitleCatUnsafeUrlError extends SubtitleCatError {
  constructor(reason: string) {
    super(`Unsafe SubtitleCat URL: ${reason}`);
    this.name = "SubtitleCatUnsafeUrlError";
  }
}

/** A response exceeded the page or file byte ceiling. */
export class SubtitleCatResponseTooBigError extends SubtitleCatError {
  constructor(url: string, maxBytes: number) {
    super(`SubtitleCat response exceeded ${maxBytes} bytes: ${url}`);
    this.name = "SubtitleCatResponseTooBigError";
  }
}

/** The provider answered, but not with something usable. */
export class SubtitleCatProviderError extends SubtitleCatError {
  constructor(message: string) {
    super(`SubtitleCat provider error: ${message}`);
    this.name = "SubtitleCatProviderError";
  }
}
