import type { LibraryEntryDto } from "@mdcz/shared/serverDtos";

export interface LibraryThumbnailRef {
  path: string | null;
  rootId: string | null;
}

export const resolveLibraryThumbnailRef = (entry: LibraryEntryDto): LibraryThumbnailRef => {
  const path = entry.thumbnailPath?.trim() || null;
  if (!path) {
    return { path: null, rootId: null };
  }

  const asset = entry.assets.find((candidate) => candidate.uri === path || candidate.relativePath === path);

  return {
    path: asset?.relativePath ?? path,
    rootId: asset?.rootId ?? entry.rootId,
  };
};
