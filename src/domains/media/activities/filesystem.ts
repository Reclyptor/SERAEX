import { rename, mkdir, access, readdir, stat, cp, rm } from 'fs/promises';
import { join, dirname, extname, basename, relative } from 'path';
import type {
  EpisodeMatch,
  AnimeSearchResult,
  RenamedFile,
  FileTreeNode,
} from '../../../shared/types';

/**
 * Rename a file to Plex naming convention:
 * "Show Name - SXXEXX - Episode Title.ext"
 *
 * Season number comes from the LLM match result (not disc directory name).
 * Renames in-place within the processing directory.
 */
export async function renameFile(
  match: EpisodeMatch,
  anime: AnimeSearchResult,
  dryRun: boolean = false,
): Promise<RenamedFile> {
  const dir = dirname(match.filePath);
  const ext = extname(match.filePath);
  const showName = sanitizeFileName(
    anime.title.english ?? anime.title.romaji,
  );
  const episodeNum = String(match.episodeNumber).padStart(2, '0');
  const seasonNum = String(match.seasonNumber).padStart(2, '0');
  const episodeTitle = sanitizeFileName(match.episodeTitle);

  // Plex naming: "Show Name - S01E01 - Episode Title.mkv"
  const newFileName = episodeTitle
    ? `${showName} - S${seasonNum}E${episodeNum} - ${episodeTitle}${ext}`
    : `${showName} - S${seasonNum}E${episodeNum}${ext}`;

  const newPath = join(dir, newFileName);

  if (!dryRun) {
    // Avoid overwriting existing files
    try {
      await access(newPath);
      // File already exists at target path
      throw new Error(`Target file already exists: ${newPath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // ENOENT means file doesn't exist, which is what we want
    }

    await rename(match.filePath, newPath);
    console.log(`Renamed: ${match.fileName} -> ${newFileName}`);
  } else {
    console.log(`[DRY RUN] Would rename: ${match.fileName} -> ${newFileName}`);
  }

  return {
    originalPath: match.filePath,
    newPath,
    newFileName,
    seasonNumber: match.seasonNumber,
    episodeNumber: match.episodeNumber,
  };
}

/**
 * Copy an entire selected series directory into the processing area.
 * The input directory is never modified.
 * Reads MEDIA_PROCESSING_ROOT from the worker's environment.
 */
export async function copyToProcessing(
  sourceSeriesDir: string,
  workflowId: string,
  dryRun: boolean = false,
): Promise<string> {
  const processingRoot =
    process.env.MEDIA_PROCESSING_ROOT ?? '/mnt/media/processing';
  const processingSeriesDir = join(
    processingRoot,
    workflowId,
    basename(sourceSeriesDir),
  );
  if (dryRun) {
    console.log(
      `[DRY RUN] Would copy series to processing: ${sourceSeriesDir} -> ${processingSeriesDir}`,
    );
    return processingSeriesDir;
  }
  await mkdir(dirname(processingSeriesDir), { recursive: true });
  await cp(sourceSeriesDir, processingSeriesDir, { recursive: true });
  console.log(
    `Copied series to processing: ${sourceSeriesDir} -> ${processingSeriesDir}`,
  );
  return processingSeriesDir;
}

/** Video file extensions */
const VIDEO_EXTENSIONS = new Set([
  '.mkv',
  '.mp4',
  '.avi',
  '.webm',
  '.m4v',
  '.mov',
  '.wmv',
  '.flv',
]);

/**
 * Build Plex-compatible directory structure in staging from a processed series.
 *
 * Takes the processing directory (where episodes have been renamed in-place by
 * processFolder) and produces:
 *
 *   <stagingRoot>/<wfId>/<ShowName>/
 *     Season 01/
 *       Show Name - S01E01 - Title.mkv
 *     Extras/
 *       <non-episode videos, preserving relative path from processing dir>
 *
 * Reads MEDIA_STAGING_ROOT from the worker's environment.
 */
export async function structureToStaging(
  processingSeriesDir: string,
  workflowId: string,
  showName: string,
  renamedFilePaths: string[],
  dryRun: boolean = false,
): Promise<{ stagingShowDir: string; extraFiles: string[] }> {
  const stagingRoot =
    process.env.MEDIA_STAGING_ROOT ?? '/mnt/media/staging';
  const cleanShowName = sanitizeFileName(showName);
  const stagingShowDir = join(stagingRoot, workflowId, cleanShowName);
  const renamedSet = new Set(renamedFilePaths);
  const extraFiles: string[] = [];

  const allFiles = await listAllFilesRecursive(processingSeriesDir);

  for (const filePath of allFiles) {
    const rel = relative(processingSeriesDir, filePath);
    const ext = extname(filePath).toLowerCase();

    if (renamedSet.has(filePath)) {
      // Episode: extract season from renamed filename (S01E01 pattern)
      const seasonMatch = basename(filePath).match(/- S(\d{2})E\d{2}/);
      const seasonDir = seasonMatch
        ? `Season ${seasonMatch[1]}`
        : 'Season 01';
      const destPath = join(stagingShowDir, seasonDir, basename(filePath));

      if (!dryRun) {
        await mkdir(dirname(destPath), { recursive: true });
        await cp(filePath, destPath);
        console.log(`Episode -> ${destPath}`);
      } else {
        console.log(`[DRY RUN] Episode -> ${destPath}`);
      }
    } else if (VIDEO_EXTENSIONS.has(ext)) {
      // Non-episode video: Extras preserving relative path
      const destPath = join(stagingShowDir, 'Extras', rel);
      extraFiles.push(rel);

      if (!dryRun) {
        await mkdir(dirname(destPath), { recursive: true });
        await cp(filePath, destPath);
        console.log(`Extra -> ${destPath}`);
      } else {
        console.log(`[DRY RUN] Extra -> ${destPath}`);
      }
    }
    // Non-video files are silently skipped
  }

  return { stagingShowDir, extraFiles };
}

/**
 * Merge a structured staging show directory into the output library.
 *
 * Walks the staging show dir and copies each file to the corresponding path
 * under output/<ShowName>/. Handles existing directories gracefully — new
 * seasons are created alongside existing ones, extras merge into the existing
 * Extras/ folder.
 *
 * Reads MEDIA_OUTPUT_ROOT from the worker's environment.
 */
export async function mergeToOutput(
  stagingShowDir: string,
  showName: string,
  dryRun: boolean = false,
): Promise<{ outputDir: string }> {
  const outputRoot =
    process.env.MEDIA_OUTPUT_ROOT ?? '/mnt/media/output';
  const cleanShowName = sanitizeFileName(showName);
  const outputDir = join(outputRoot, cleanShowName);

  const allFiles = await listAllFilesRecursive(stagingShowDir);

  for (const filePath of allFiles) {
    const rel = relative(stagingShowDir, filePath);
    const destPath = join(outputDir, rel);

    if (!dryRun) {
      await mkdir(dirname(destPath), { recursive: true });
      await cp(filePath, destPath);
      console.log(`Output -> ${destPath}`);
    } else {
      console.log(`[DRY RUN] Output -> ${destPath}`);
    }
  }

  return { outputDir };
}

/**
 * Clean up a processing directory after structuring to staging.
 */
export async function cleanupProcessing(
  processingWorkflowDir: string,
  dryRun: boolean = false,
): Promise<void> {
  if (dryRun) {
    console.log(
      `[DRY RUN] Would clean up processing: ${processingWorkflowDir}`,
    );
    return;
  }
  await rm(processingWorkflowDir, { recursive: true, force: true });
  console.log(`Cleaned up processing: ${processingWorkflowDir}`);
}

/**
 * Clean up a staging directory after merging to output.
 */
export async function cleanupStaging(
  stagingWorkflowDir: string,
  dryRun: boolean = false,
): Promise<void> {
  if (dryRun) {
    console.log(
      `[DRY RUN] Would clean up staging: ${stagingWorkflowDir}`,
    );
    return;
  }
  await rm(stagingWorkflowDir, { recursive: true, force: true });
  console.log(`Cleaned up staging: ${stagingWorkflowDir}`);
}

/**
 * Build a recursive file tree structure for a directory.
 * Used to let the user review the staged output before finalizing.
 */
export async function listStagingTree(
  rootDir: string,
): Promise<FileTreeNode[]> {
  return buildTree(rootDir, rootDir);
}

async function buildTree(
  currentDir: string,
  rootDir: string,
): Promise<FileTreeNode[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const nodes: FileTreeNode[] = [];

  // Sort: directories first, then files, alphabetically within each group
  const sorted = entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    const fullPath = join(currentDir, entry.name);
    const relativePath = relative(rootDir, fullPath);

    if (entry.isDirectory()) {
      const children = await buildTree(fullPath, rootDir);
      nodes.push({
        name: entry.name,
        type: 'directory',
        relativePath,
        children,
      });
    } else if (entry.isFile()) {
      const fileStat = await stat(fullPath);
      nodes.push({
        name: entry.name,
        type: 'file',
        relativePath,
        size: fileStat.size,
      });
    }
  }

  return nodes;
}

/**
 * Recursively list all files in a directory.
 */
async function listAllFilesRecursive(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await listAllFilesRecursive(fullPath);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Sanitize a string for use as a file name.
 * Removes or replaces characters that are invalid in file systems.
 */
function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '') // Remove invalid characters
    .replace(/\s+/g, ' ') // Collapse whitespace
    .trim();
}
