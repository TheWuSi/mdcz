import { parseFileInfo } from "../utils/number";

/**
 * The same-number grouping of one scrape session, derived from the files that were actually
 * submitted rather than from whatever happens to be in flight.
 *
 * `parseFileInfo()` normalizes `ABC-111`, `ABC-111-C` and `ABC-111-UC` onto one base code, so the
 * plan knows up front that those three belong together. Two things read it: the session scope stays
 * alive while any member is still pending (instead of being reaped on an idle timer), and a retry
 * rejoins its siblings' group instead of starting a scope — and therefore a `NumberExecutionGate` —
 * of its own, which would let two variants write the same output directory at once.
 */
export class BaseCodeGroupPlan {
  /** Base code → the not-yet-finished members submitted under it. */
  readonly #pendingByBaseCode = new Map<string, Set<string>>();

  /** Every member ever submitted, so `complete()` stays idempotent across retries. */
  readonly #baseCodeByMember = new Map<string, string>();

  /** Adds every path in one go; safe to call more than once as a session grows. */
  seed(filePaths: readonly string[], escapeStrings: readonly string[] = []): void {
    for (const filePath of filePaths) {
      this.add(filePath, escapeStrings);
    }
  }

  add(filePath: string, escapeStrings: readonly string[] = []): void {
    const member = normalizeMember(filePath);
    if (!member) {
      return;
    }

    const baseCode = this.#baseCodeByMember.get(member) ?? toBaseCode(filePath, escapeStrings);
    if (!baseCode) {
      return;
    }

    this.#baseCodeByMember.set(member, baseCode);
    const pending = this.#pendingByBaseCode.get(baseCode) ?? new Set<string>();
    pending.add(member);
    this.#pendingByBaseCode.set(baseCode, pending);
  }

  complete(filePath: string): void {
    const member = normalizeMember(filePath);
    const baseCode = this.#baseCodeByMember.get(member);
    if (!baseCode) {
      return;
    }

    const pending = this.#pendingByBaseCode.get(baseCode);
    pending?.delete(member);
    if (pending?.size === 0) {
      this.#pendingByBaseCode.delete(baseCode);
    }
  }

  /** True while any submitted file has yet to finish, which is what holds the caches open. */
  hasPending(): boolean {
    return this.#pendingByBaseCode.size > 0;
  }

  pendingMembers(baseCode: string): number {
    return this.#pendingByBaseCode.get(normalizeBaseCode(baseCode))?.size ?? 0;
  }

  clear(): void {
    this.#pendingByBaseCode.clear();
    this.#baseCodeByMember.clear();
  }
}

const normalizeMember = (filePath: string): string => filePath.trim();

const normalizeBaseCode = (baseCode: string): string => baseCode.trim().toUpperCase();

const toBaseCode = (filePath: string, escapeStrings: readonly string[]): string =>
  normalizeBaseCode(parseFileInfo(filePath, [...escapeStrings]).number);
