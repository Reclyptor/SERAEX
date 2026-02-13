import { rename, mkdir, access, readdir, stat, cp, rm } from 'fs/promises';
import { join, dirname, extname, basename, relative } from 'path';
import { Context } from '@temporalio/activity';
import type {
  EpisodeMatch,
  AnimeSearchResult,
  RenamedFile,
  FileTreeNode,
  SourceFileInfo,
} from '../../../shared/types';

// ── Constants ────────────────────────────────────────────────────────

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

/** Directories prefixed with _ are working dirs and should be ignored */
function isWorkDir(name: string): boolean {
  return name.startsWith('_');
}

// ── Heartbeat helper ─────────────────────────────────────────────────

/**
 * Run an async operation while sending Temporal heartbeats on a timer.
 * Keeps the activity alive even when a single I/O operation (e.g. copying
 * a multi-GB file over NFS) takes longer than the heartbeat timeout.
 */
async function withHeartbeat<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = Context.current();
  const interval = setInterval(() => ctx.heartbeat(), 30_000);
  ctx.heartbeat();
  try {
    return await fn();
  } finally {
    clearInterval(interval);
  }
}

// ── File Enumeration ─────────────────────────────────────────────────

/**
 * Recursively list all files under a directory with sizes.
 * Used to enumerate files before parallel copy operations.
 */
export async function enumerateSourceFiles(
  rootDir: string,
): Promise<SourceFileInfo[]> {
  const files: SourceFileInfo[] = [];
  await walkDir(rootDir, rootDir, files);
  return files;
}

async function walkDir(
  currentDir: string,
  rootDir: string,
  out: SourceFileInfo[],
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(fullPath, rootDir, out);
    } else if (entry.isFile()) {
      const fileStat = await stat(fullPath);
      out.push({
        path: fullPath,
        relativePath: relative(rootDir, fullPath),
        name: entry.name,
        size: fileStat.size,
      });
    }
  }
}

// ── Single File Copy ─────────────────────────────────────────────────

/**
 * Copy a single file from source to destination.
 * Creates parent directories as needed. Heartbeated for large files.
 */
export async function copySingleFile(
  src: string,
  dest: string,
): Promise<{ bytesWritten: number }> {
  await mkdir(dirname(dest), { recursive: true });
  const fileStat = await stat(src);
  await withHeartbeat(() => cp(src, dest));
  console.log(`Copied: ${basename(src)} (${formatBytes(fileStat.size)})`);
  return { bytesWritten: fileStat.size };
}

// ── Episode Copy-Rename ──────────────────────────────────────────────

/**
 * Copy a matched episode file into the `_episodes/` working directory
 * with the Plex naming convention. Idempotent: skips if target exists.
 *
 * This replaces the old `renameFile` activity. Originals are never modified.
 */
export async function copyEpisodeToWorkDir(
  match: EpisodeMatch,
  anime: AnimeSearchResult,
  episodesDir: string,
  seriesRootDir: string,
  dryRun: boolean = false,
): Promise<RenamedFile> {
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

  const seasonDir = join(episodesDir, `Season ${seasonNum}`);
  const newPath = join(seasonDir, newFileName);
  const originalRelativePath = relative(seriesRootDir, match.filePath);

  if (dryRun) {
    console.log(`[DRY RUN] Would copy episode: ${match.fileName} -> ${newFileName}`);
    return { originalPath: match.filePath, originalRelativePath, newPath, newFileName, seasonNumber: match.seasonNumber, episodeNumber: match.episodeNumber };
  }

  // Idempotent: skip if target already exists
  try {
    await access(newPath);
    console.log(`Episode already copied, skipping: ${newFileName}`);
    return { originalPath: match.filePath, originalRelativePath, newPath, newFileName, seasonNumber: match.seasonNumber, episodeNumber: match.episodeNumber };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  await mkdir(seasonDir, { recursive: true });
  await withHeartbeat(() => cp(match.filePath, newPath));
  console.log(`Episode copied: ${match.fileName} -> ${newFileName}`);

  return {
    originalPath: match.filePath,
    originalRelativePath,
    newPath,
    newFileName,
    seasonNumber: match.seasonNumber,
    episodeNumber: match.episodeNumber,
  };
}

// ── Structure in Processing ──────────────────────────────────────────

/**
 * Build the final Plex-ready directory structure inside `_structured/`
 * within the processing series directory.
 *
 * - Moves episode files from `_episodes/Season XX/` into
 *   `_structured/ShowName/Season XX/` (same filesystem = instant rename).
 * - Copies non-episode video files from original disc dirs into
 *   `_structured/ShowName/Extras/{relative_path}`.
 *
 * All work happens in the processing directory. Nothing touches staging.
 */
export async function structureInProcessing(
  processingSeriesDir: string,
  showName: string,
  episodeOriginalPaths: string[],
  dryRun: boolean = false,
): Promise<{ structuredDir: string; extraFiles: string[]; totalFiles: number }> {
  const cleanShowName = sanitizeFileName(showName);
  const structuredShowDir = join(processingSeriesDir, '_structured', cleanShowName);
  const episodesDir = join(processingSeriesDir, '_episodes');
  const episodePathSet = new Set(episodeOriginalPaths);
  const extraFiles: string[] = [];
  let totalFiles = 0;

  // ── Move episodes from _episodes/ to _structured/ShowName/ ──
  const episodeDirEntries = await safeReaddir(episodesDir);
  for (const seasonEntry of episodeDirEntries) {
    if (!seasonEntry.isDirectory()) continue;
    const seasonName = seasonEntry.name; // e.g., "Season 01"
    const srcSeasonDir = join(episodesDir, seasonName);
    const destSeasonDir = join(structuredShowDir, seasonName);

    const files = await readdir(srcSeasonDir, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile()) continue;
      const srcPath = join(srcSeasonDir, file.name);
      const destPath = join(destSeasonDir, file.name);

      if (dryRun) {
        console.log(`[DRY RUN] Would move episode: ${srcPath} -> ${destPath}`);
      } else {
        await mkdir(destSeasonDir, { recursive: true });
        await rename(srcPath, destPath); // Same FS, instant
        console.log(`Episode -> ${destPath}`);
      }
      totalFiles++;
    }
  }

  // ── Copy non-episode video files to Extras/ ──
  const allOriginalFiles = await listOriginalFiles(processingSeriesDir);
  for (const filePath of allOriginalFiles) {
    if (episodePathSet.has(filePath)) continue;

    const ext = extname(filePath).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext)) continue;

    const rel = relative(processingSeriesDir, filePath);
    const destPath = join(structuredShowDir, 'Extras', rel);
    extraFiles.push(rel);

    if (dryRun) {
      console.log(`[DRY RUN] Extra -> ${destPath}`);
    } else {
      await mkdir(dirname(destPath), { recursive: true });
      await cp(filePath, destPath);
      console.log(`Extra -> ${destPath}`);
    }
    totalFiles++;
  }

  return { structuredDir: structuredShowDir, extraFiles, totalFiles };
}

/**
 * List all files in the original disc directories (skipping _ working dirs).
 */
async function listOriginalFiles(seriesDir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(seriesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (isWorkDir(entry.name)) continue;
    const fullPath = join(seriesDir, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await listAllFilesRecursive(fullPath);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

// ── Single File Copy to Output ───────────────────────────────────────

/**
 * Copy a single file from a source root to an output root,
 * preserving its relative path. Used for staging → output copies.
 */
export async function copySingleFileToOutput(
  filePath: string,
  sourceRoot: string,
  outputRoot: string,
): Promise<{ bytesWritten: number }> {
  const rel = relative(sourceRoot, filePath);
  const destPath = join(outputRoot, rel);
  await mkdir(dirname(destPath), { recursive: true });
  const fileStat = await stat(filePath);
  await withHeartbeat(() => cp(filePath, destPath));
  console.log(`Output -> ${destPath}`);
  return { bytesWritten: fileStat.size };
}

// ── Output Integrity Verification ────────────────────────────────────

/**
 * Verify that every file in the source directory exists in the output
 * directory with a matching size. Used after copying staging → output.
 */
export async function verifyOutputIntegrity(
  sourceDir: string,
  outputDir: string,
): Promise<{ verified: boolean; missingFiles: string[] }> {
  const sourceFiles = await listAllFilesRecursive(sourceDir);
  const missingFiles: string[] = [];

  for (const srcFile of sourceFiles) {
    const rel = relative(sourceDir, srcFile);
    const destFile = join(outputDir, rel);

    try {
      const srcStat = await stat(srcFile);
      const destStat = await stat(destFile);

      if (srcStat.size !== destStat.size) {
        missingFiles.push(rel);
        console.warn(`Size mismatch: ${rel} (src=${srcStat.size}, dest=${destStat.size})`);
      }
    } catch {
      missingFiles.push(rel);
      console.warn(`Missing in output: ${rel}`);
    }
  }

  const verified = missingFiles.length === 0;
  if (verified) {
    console.log(`Output integrity verified: ${sourceFiles.length} files OK`);
  } else {
    console.error(`Output integrity FAILED: ${missingFiles.length} missing/mismatched files`);
  }

  return { verified, missingFiles };
}

// ── Cleanup ──────────────────────────────────────────────────────────

/**
 * Recursively remove a directory. Generalized replacement for the old
 * separate cleanupProcessing/cleanupStaging functions.
 */
export async function cleanupDirectory(
  directory: string,
  dryRun: boolean = false,
): Promise<void> {
  if (dryRun) {
    console.log(`[DRY RUN] Would clean up: ${directory}`);
    return;
  }
  await withHeartbeat(() => rm(directory, { recursive: true, force: true }));
  console.log(`Cleaned up: ${directory}`);
}

// ── Staging Tree ─────────────────────────────────────────────────────

/**
 * Build a recursive file tree structure for a directory.
 * Used to let the user review the staged output before finalizing.
 */
export async function listStagingTree(
  rootDir: string,
): Promise<FileTreeNode[]> {
  return withHeartbeat(() => buildTree(rootDir, rootDir));
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

// ── Helpers ──────────────────────────────────────────────────────────

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

async function safeReaddir(
  dir: string,
): Promise<import('fs').Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
