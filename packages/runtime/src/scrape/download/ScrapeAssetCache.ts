import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getImageFileExtensionForFormat, type ImageFileFormat, replaceImageFileExtension } from "../utils/image";

export interface CachedScrapeAsset {
  path: string;
  width: number;
  height: number;
  format?: ImageFileFormat;
}

/**
 * Downloads every image URL at most once per scrape session.
 *
 * Variants of one base code (`ABC-111`, `ABC-111-C`, `ABC-111-UC`) share their metadata and therefore
 * their poster / fanart / scene image URLs. The first task downloads to its own output path as usual
 * and leaves a copy of the untouched bytes here; every later task copies from that instead of hitting
 * the network again. Each task keeps a private file, so cropping and watermarking stay per task.
 *
 * Nothing is cached across sessions on purpose: a re-scrape hours later must see the live artwork.
 */
export class ScrapeAssetCache {
  private readonly entries = new Map<string, Promise<CachedScrapeAsset | null>>();

  private directory: Promise<string> | null = null;

  private nextFileIndex = 0;

  private disposed = false;

  /** The in-flight or settled entry for `url`, or `undefined` when nothing has been attempted yet. */
  get(url: string): Promise<CachedScrapeAsset | null> | undefined {
    return this.entries.get(url.trim());
  }

  /**
   * Memoizes `request` so sibling variants await the same download instead of starting their own, and
   * forgets it again once it fails so a later task may retry.
   */
  track(url: string, request: Promise<CachedScrapeAsset | null>): void {
    const key = url.trim();
    if (this.disposed || !key) {
      return;
    }

    this.entries.set(key, request);
    const forgetOnFailure = (cached: CachedScrapeAsset | null): void => {
      if (!cached && this.entries.get(key) === request) {
        this.entries.delete(key);
      }
    };
    request.then(forgetOnFailure, () => forgetOnFailure(null));
  }

  /**
   * Copies freshly downloaded bytes into the session directory via `copy`, which reports the path it
   * actually wrote. Returns `null` when the copy fails, which only costs the next task a re-download.
   */
  async put(
    url: string,
    asset: CachedScrapeAsset,
    copy: (targetPath: string) => Promise<string | null>,
  ): Promise<CachedScrapeAsset | null> {
    if (this.disposed || !url.trim()) {
      return null;
    }

    const copiedPath = await copy(await this.allocatePath(asset));
    return copiedPath ? { ...asset, path: copiedPath } : null;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.entries.clear();
    const directory = this.directory;
    this.directory = null;
    const directoryPath = await directory?.catch(() => undefined);
    if (directoryPath) {
      await rm(directoryPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async allocatePath(asset: CachedScrapeAsset): Promise<string> {
    const directory = await this.ensureDirectory();
    this.nextFileIndex += 1;
    const candidate = join(directory, `asset-${this.nextFileIndex}.img`);
    const extension = getImageFileExtensionForFormat(asset.format);
    return extension ? replaceImageFileExtension(candidate, extension) : candidate;
  }

  private async ensureDirectory(): Promise<string> {
    this.directory ??= mkdtemp(join(tmpdir(), "mdcz-asset-"));
    return await this.directory;
  }
}
