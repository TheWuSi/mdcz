import { copyFile, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, normalize, resolve } from "node:path";
import { toErrorMessage } from "@mdcz/shared/error";
import {
  buildGeneratedVideoSidecarTargetPath,
  buildSubtitleSidecarEmbyTargetPaths,
  buildSubtitleSidecarTargetPath,
  type SubtitleSidecarMatch,
} from "../media";
import { moveFileSafely, pathExists } from "../utils/filesystem";
import { inspectStrmTarget, isStrmFile, writeStrmTarget } from "../utils/strm";
import type { SidecarResolver } from "./SidecarResolver";

interface OrganizeLogger {
  info(message: string): void;
}

type MovedArtifact = {
  sourcePath: string;
  targetPath: string;
  label: string;
};

/**
 * Resolves the on-disk name for every subtitle sidecar, honouring the EMBY layout when enabled.
 * `PathPlanner` runs the identical mapping over the same ordered list so both agree.
 */
const resolveSubtitleTargetPaths = (
  sidecars: readonly SubtitleSidecarMatch[],
  targetVideoPath: string,
  embySubtitleNaming: boolean,
): string[] =>
  embySubtitleNaming
    ? buildSubtitleSidecarEmbyTargetPaths(sidecars, targetVideoPath)
    : sidecars.map((sidecar) => buildSubtitleSidecarTargetPath(sidecar, targetVideoPath));

export class FileMover {
  constructor(
    private readonly logger: OrganizeLogger,
    private readonly sidecarResolver: SidecarResolver,
  ) {}

  async moveBundledMedia(
    sourceVideoPath: string,
    targetVideoPath: string,
    options: {
      subtitleSidecars?: SubtitleSidecarMatch[];
      sharedMovieBaseName: string;
      embySubtitleNaming?: boolean;
    },
  ): Promise<string> {
    const sidecars = await this.sidecarResolver.resolve(sourceVideoPath, options.subtitleSidecars);
    const movedArtifacts: MovedArtifact[] = [];
    let movedVideoPath: string | undefined;
    let originalStrmContent: string | undefined;
    let rewrittenStrmTarget: string | undefined;

    if (isStrmFile(sourceVideoPath) && resolve(dirname(sourceVideoPath)) !== resolve(dirname(targetVideoPath))) {
      const strmTarget = await inspectStrmTarget(sourceVideoPath);
      if (strmTarget?.kind === "relative_path" && strmTarget.resolvedPath) {
        originalStrmContent = await readFile(sourceVideoPath, "utf8");
        rewrittenStrmTarget = strmTarget.resolvedPath;
      }
    }

    try {
      movedVideoPath = await moveFileSafely(sourceVideoPath, targetVideoPath);
      if (movedVideoPath && rewrittenStrmTarget) {
        await writeStrmTarget(movedVideoPath, rewrittenStrmTarget);
        this.logger.info(`Rewrote relative STRM target to absolute path: ${movedVideoPath}`);
      }

      const subtitleTargetPaths = resolveSubtitleTargetPaths(
        sidecars.subtitleSidecars,
        movedVideoPath,
        Boolean(options.embySubtitleNaming),
      );
      for (const [index, subtitleSidecar] of sidecars.subtitleSidecars.entries()) {
        const movedSubtitlePath = await moveFileSafely(subtitleSidecar.path, subtitleTargetPaths[index]);
        movedArtifacts.push({
          sourcePath: subtitleSidecar.path,
          targetPath: movedSubtitlePath,
          label: "subtitle",
        });
        this.logger.info(`Moved subtitle sidecar to ${movedSubtitlePath}`);
      }

      for (const generatedVideoSidecar of sidecars.generatedVideoSidecars) {
        const targetSidecarPath = buildGeneratedVideoSidecarTargetPath(
          generatedVideoSidecar,
          dirname(movedVideoPath),
          options.sharedMovieBaseName,
        );
        const movedSidecarPath = await moveFileSafely(generatedVideoSidecar.path, targetSidecarPath);
        movedArtifacts.push({
          sourcePath: generatedVideoSidecar.path,
          targetPath: movedSidecarPath,
          label: "generated sidecar",
        });
        this.logger.info(`Moved generated video sidecar to ${movedSidecarPath}`);
      }

      return movedVideoPath;
    } catch (error) {
      const rollbackErrors = await this.rollbackMovedArtifacts(
        movedArtifacts,
        movedVideoPath,
        sourceVideoPath,
        originalStrmContent,
      );
      const message = toErrorMessage(error);
      if (rollbackErrors.length > 0) {
        throw new Error(`Failed to move bundled media: ${message}. Rollback failed: ${rollbackErrors.join("; ")}`);
      }

      throw new Error(`Failed to move bundled media: ${message}`);
    }
  }

  async createSeparatedStrmBundle(
    sourceVideoPath: string,
    targetStrmPath: string,
    options: {
      subtitleSidecars?: SubtitleSidecarMatch[];
      sharedMovieBaseName: string;
      embySubtitleNaming?: boolean;
    },
  ): Promise<string> {
    const sidecars = await this.sidecarResolver.resolve(sourceVideoPath, options.subtitleSidecars);
    const copied: string[] = [];
    try {
      const playableTarget = resolve(sourceVideoPath);
      if (isStrmFile(sourceVideoPath)) {
        const sourceTarget = await inspectStrmTarget(sourceVideoPath);
        if (!sourceTarget) {
          throw new Error(`STRM 文件不包含有效目标：${sourceVideoPath}`);
        }
        await copyFile(sourceVideoPath, targetStrmPath);
        copied.push(targetStrmPath);
        if (sourceTarget.kind === "relative_path" && sourceTarget.resolvedPath) {
          await writeStrmTarget(targetStrmPath, sourceTarget.resolvedPath);
        }
      } else {
        await writeStrmTarget(targetStrmPath, playableTarget);
        copied.push(targetStrmPath);
      }

      // Separated mode copies out of the source directory and never writes back into it.
      const subtitleTargets = resolveSubtitleTargetPaths(
        sidecars.subtitleSidecars,
        targetStrmPath,
        Boolean(options.embySubtitleNaming),
      );
      for (const [index, subtitle] of sidecars.subtitleSidecars.entries()) {
        const target = subtitleTargets[index];
        await copyFile(subtitle.path, target);
        copied.push(target);
      }
      for (const generated of sidecars.generatedVideoSidecars) {
        const mediaTarget = buildGeneratedVideoSidecarTargetPath(
          generated,
          dirname(targetStrmPath),
          options.sharedMovieBaseName,
        );
        const extension = extname(mediaTarget);
        const target = `${extension ? mediaTarget.slice(0, -extension.length) : mediaTarget}.strm`;
        await writeStrmTarget(target, resolve(generated.path));
        copied.push(target);
      }
      return targetStrmPath;
    } catch (error) {
      await Promise.all(copied.map((path) => rm(path, { force: true }).catch(() => undefined)));
      throw error;
    }
  }

  async cleanupEmptyAncestors(dirPath: string, stopAt: string): Promise<void> {
    const normalizedStop = normalize(resolve(stopAt));
    let current = normalize(resolve(dirPath));

    while (current.length > normalizedStop.length && current.startsWith(normalizedStop)) {
      try {
        const entries = await readdir(current);
        if (entries.length > 0) {
          break;
        }
        await rm(current, { recursive: true });
        this.logger.info(`Deleted empty folder: ${current}`);
        current = dirname(current);
      } catch {
        break;
      }
    }
  }

  private async rollbackMovedArtifacts(
    movedArtifacts: MovedArtifact[],
    movedVideoPath: string | undefined,
    sourceVideoPath: string,
    originalVideoContent?: string,
  ): Promise<string[]> {
    const rollbackErrors: string[] = [];

    for (const artifact of movedArtifacts.reverse()) {
      try {
        await moveFileSafely(artifact.targetPath, artifact.sourcePath);
      } catch (rollbackError) {
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        rollbackErrors.push(`${artifact.label} ${artifact.targetPath}: ${rollbackMessage}`);
      }
    }

    if (movedVideoPath && (await pathExists(movedVideoPath))) {
      if (originalVideoContent !== undefined) {
        try {
          await writeFile(movedVideoPath, originalVideoContent, "utf8");
        } catch (rollbackError) {
          const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          rollbackErrors.push(`video content ${movedVideoPath}: ${rollbackMessage}`);
        }
      }

      try {
        await moveFileSafely(movedVideoPath, sourceVideoPath);
      } catch (rollbackError) {
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        rollbackErrors.push(`video ${movedVideoPath}: ${rollbackMessage}`);
      }
    }

    return rollbackErrors;
  }
}
