import type { DownloadedSubtitle } from "./types";

/**
 * Memoizes one SubtitleCat lookup per base code for the lifetime of a scrape session, so `ABC-111`,
 * `ABC-111-C` and `ABC-111-UC` in the same batch search and download at most once between them.
 *
 * Subtitles are small enough to keep in memory; nothing is written to disk here.
 */
export class BaseCodeSubtitleCache {
  private readonly entries = new Map<string, Promise<DownloadedSubtitle | undefined>>();

  async resolve(
    baseCode: string,
    load: () => Promise<DownloadedSubtitle | undefined>,
  ): Promise<DownloadedSubtitle | undefined> {
    const key = baseCode.trim().toUpperCase();
    const pending = this.entries.get(key);
    if (pending) {
      return pending;
    }

    const lookup = load();
    this.entries.set(key, lookup);
    // A thrown lookup must not poison the entry for the sibling variants still to come.
    lookup.catch(() => this.entries.delete(key));
    return lookup;
  }

  /** Forgets one base code so a retry searches again, including after a "nothing found" result. */
  invalidate(baseCode: string): void {
    this.entries.delete(baseCode.trim().toUpperCase());
  }

  clear(): void {
    this.entries.clear();
  }
}
