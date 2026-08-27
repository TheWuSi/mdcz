import type { AggregationService } from "../aggregation";
import { ScrapeAssetCache } from "../download/ScrapeAssetCache";
import { BaseCodeSubtitleCache } from "../subtitles/BaseCodeSubtitleCache";
import { AggregationCoordinator } from "./AggregationCoordinator";
import { BaseCodeGroupPlan } from "./BaseCodeGroupPlan";
import { NumberExecutionGate } from "./NumberExecutionGate";

/**
 * Everything a single batch shares between its files.
 *
 * `parseFileInfo()` already normalizes `ABC-111`, `ABC-111-C` and `ABC-111-UC` to one base code, so all
 * four members key off that same number: the gate serializes the variants, and the three caches make
 * metadata, artwork and subtitles a once-per-base-code cost instead of once-per-file. `groups` records
 * which files were submitted under each base code, so that sharing follows the task list rather than
 * whatever the worker pool happens to be running at the same moment.
 *
 * The scope must never be process-wide. `AggregationCoordinator` keeps successful results forever, so a
 * shared instance would hand hours-old metadata to a fresh re-scrape.
 */
export class ScrapeSessionScope {
  readonly numberExecutionGate = new NumberExecutionGate();

  readonly aggregationCoordinator: AggregationCoordinator;

  readonly assetCache = new ScrapeAssetCache();

  readonly subtitleCache = new BaseCodeSubtitleCache();

  readonly groups = new BaseCodeGroupPlan();

  constructor(aggregationService: Pick<AggregationService, "aggregate">) {
    this.aggregationCoordinator = new AggregationCoordinator(aggregationService);
  }

  /**
   * Drops one base code's cached metadata and subtitle lookup so a user-initiated retry starts from
   * live data. Targeted on purpose: replacing the whole scope would also replace the
   * `NumberExecutionGate`, and the retried file could then run alongside a sibling variant still
   * writing the same output directory.
   *
   * The asset cache is deliberately left alone — it forgets failed downloads on its own, so anything
   * still in it is a success that cannot have caused the failure being retried.
   */
  invalidateBaseCode(baseCode: string): void {
    this.aggregationCoordinator.invalidate(baseCode);
    this.subtitleCache.invalidate(baseCode);
  }

  async dispose(): Promise<void> {
    this.groups.clear();
    this.subtitleCache.clear();
    await this.assetCache.dispose();
  }
}
