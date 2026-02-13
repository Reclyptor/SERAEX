import { execFile } from 'child_process';
import { readFile, writeFile, readdir, stat, mkdtemp, rm, mkdir, access } from 'fs/promises';
import { join, basename, extname, dirname } from 'path';
import { tmpdir } from 'os';
import { promisify } from 'util';
import type {
  SourceFileInfo,
  EpisodeDetectionResult,
  SubtitleTrack,
  ExtractedSubtitles,
} from '../../../shared/types';

const execFileAsync = promisify(execFile);

/** Video file extensions to consider */
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

/** External subtitle extensions */
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.ass', '.ssa', '.sub', '.vtt']);

// ── Episode Detection (File Size Clustering) ─────────────────────────

/**
 * Detect which video files in a folder are likely episodes by finding
 * the most common file-size cluster.
 *
 * Algorithm:
 * 1. List all video files and get their sizes via stat().
 * 2. Sort by size, build a histogram with adaptive bin width.
 * 3. Find the bin with the highest file count (primary cluster).
 * 4. Expand to include files within +/-20% of the cluster median.
 * 5. Assign confidence based on cluster strength.
 */
export async function detectEpisodeFiles(
  folderPath: string,
): Promise<EpisodeDetectionResult> {
  // List all video files recursively
  const videoFiles = await listVideoFilesRecursive(folderPath);

  if (videoFiles.length === 0) {
    return {
      episodes: [],
      nonEpisodes: [],
      confidence: 'low',
      clusterMedianSize: 0,
      clusterSizeRange: [0, 0],
    };
  }

  // If there's only 1-2 files, they're all episodes
  if (videoFiles.length <= 2) {
    return {
      episodes: videoFiles,
      nonEpisodes: [],
      confidence: videoFiles.length === 1 ? 'medium' : 'low',
      clusterMedianSize: videoFiles[0].size,
      clusterSizeRange: [
        Math.min(...videoFiles.map((f) => f.size)),
        Math.max(...videoFiles.map((f) => f.size)),
      ],
    };
  }

  // Sort by size
  const sorted = [...videoFiles].sort((a, b) => a.size - b.size);
  const sizes = sorted.map((f) => f.size);

  // Build histogram with adaptive bin width
  const minSize = sizes[0];
  const maxSize = sizes[sizes.length - 1];
  const range = maxSize - minSize;
  const binWidth = Math.max(50 * 1024 * 1024, range / 20); // At least 50MB bins

  // Assign files to bins
  const bins = new Map<number, SourceFileInfo[]>();
  for (const file of sorted) {
    const binIndex = Math.floor((file.size - minSize) / binWidth);
    if (!bins.has(binIndex)) bins.set(binIndex, []);
    bins.get(binIndex)!.push(file);
  }

  // Find the largest bin
  let largestBin: SourceFileInfo[] = [];
  for (const binFiles of bins.values()) {
    if (binFiles.length > largestBin.length) {
      largestBin = binFiles;
    }
  }

  // Calculate median of the largest cluster
  const clusterSizes = largestBin.map((f) => f.size).sort((a, b) => a - b);
  const medianIdx = Math.floor(clusterSizes.length / 2);
  const clusterMedian =
    clusterSizes.length % 2 === 0
      ? (clusterSizes[medianIdx - 1] + clusterSizes[medianIdx]) / 2
      : clusterSizes[medianIdx];

  // Expand cluster: include all files within +/-20% of median
  const lowerBound = clusterMedian * 0.8;
  const upperBound = clusterMedian * 1.2;

  const episodes: SourceFileInfo[] = [];
  const nonEpisodes: SourceFileInfo[] = [];

  for (const file of videoFiles) {
    if (file.size >= lowerBound && file.size <= upperBound) {
      episodes.push(file);
    } else {
      nonEpisodes.push(file);
    }
  }

  // Determine confidence
  const episodeRatio = episodes.length / videoFiles.length;
  let confidence: 'high' | 'medium' | 'low';

  if (episodes.length >= 6 && episodeRatio > 0.6) {
    confidence = 'high';
  } else if (episodes.length >= 3) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  const clusterSizeRange: [number, number] = [
    Math.min(...episodes.map((f) => f.size)),
    Math.max(...episodes.map((f) => f.size)),
  ];

  console.log(
    `Episode detection: ${episodes.length}/${videoFiles.length} files in cluster ` +
      `(${formatBytes(clusterSizeRange[0])}-${formatBytes(clusterSizeRange[1])}), ` +
      `confidence: ${confidence}`,
  );

  return {
    episodes,
    nonEpisodes,
    confidence,
    clusterMedianSize: clusterMedian,
    clusterSizeRange,
  };
}

async function listVideoFilesRecursive(
  directory: string,
): Promise<SourceFileInfo[]> {
  const files: SourceFileInfo[] = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    // Skip working directories
    if (entry.name.startsWith('_')) continue;

    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await listVideoFilesRecursive(fullPath);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (VIDEO_EXTENSIONS.has(ext)) {
        const fileStat = await stat(fullPath);
        files.push({
          path: fullPath,
          relativePath: entry.name, // will be overridden by caller if needed
          name: entry.name,
          size: fileStat.size,
        });
      }
    }
  }

  return files;
}

// ── Subtitle Extraction (Persistent, Idempotent) ─────────────────────

/**
 * Extract subtitles from a single media file and save the stripped text
 * to the persistent `_subtitles/` directory.
 *
 * Idempotent: if the subtitle text file already exists, it is read and
 * returned without re-extracting.
 */
export async function extractSubtitleToDir(
  mediaFilePath: string,
  mediaFileName: string,
  subtitlesDir: string,
): Promise<ExtractedSubtitles | null> {
  const subtitleFileName = replaceExtension(mediaFileName, '.txt');
  const subtitleFilePath = join(subtitlesDir, subtitleFileName);

  // Idempotent: return cached subtitle if already extracted
  try {
    await access(subtitleFilePath);
    const content = await readFile(subtitleFilePath, 'utf-8');
    console.log(`Subtitle already extracted, using cache: ${subtitleFileName}`);
    return {
      filePath: mediaFilePath,
      fileName: mediaFileName,
      content,
      source: 'embedded', // we don't know the original source from cache
      language: 'unknown',
    };
  } catch {
    // File doesn't exist, extract it
  }

  const ext = extname(mediaFilePath).toLowerCase();

  // Try external subtitles first
  const externalSubs = await findExternalSubtitles(mediaFilePath, mediaFileName, ext);
  if (externalSubs) {
    await persistSubtitle(subtitlesDir, subtitleFileName, externalSubs.content);
    return externalSubs;
  }

  // Fall back to embedded subtitles
  const embeddedSubs = await extractEmbeddedSubtitles(mediaFilePath, mediaFileName, ext);
  if (embeddedSubs) {
    await persistSubtitle(subtitlesDir, subtitleFileName, embeddedSubs.content);
    return embeddedSubs;
  }

  return null;
}

async function persistSubtitle(
  subtitlesDir: string,
  fileName: string,
  content: string,
): Promise<void> {
  await mkdir(subtitlesDir, { recursive: true });
  await writeFile(join(subtitlesDir, fileName), content, 'utf-8');
  console.log(`Subtitle saved: ${fileName}`);
}

// ── Subtitle Extraction Internals ────────────────────────────────────

async function findExternalSubtitles(
  mediaFilePath: string,
  mediaFileName: string,
  mediaExt: string,
): Promise<ExtractedSubtitles | null> {
  const dir = dirname(mediaFilePath);
  const baseName = basename(mediaFileName, mediaExt);

  try {
    const entries = await readdir(dir);

    const subtitleFiles: Array<{ path: string; language?: string }> = [];

    for (const entry of entries) {
      const ext = extname(entry).toLowerCase();
      if (!SUBTITLE_EXTENSIONS.has(ext)) continue;

      const entryBase = basename(entry, ext);
      if (entryBase.startsWith(baseName)) {
        const langSuffix = entryBase.slice(baseName.length).replace(/^\./, '');
        subtitleFiles.push({
          path: join(dir, entry),
          language: langSuffix || undefined,
        });
      }
    }

    if (subtitleFiles.length === 0) return null;

    // Prefer English subtitles
    const preferred =
      subtitleFiles.find(
        (s) => s.language && /^en/i.test(s.language),
      ) ?? subtitleFiles[0];

    const content = await readFile(preferred.path, 'utf-8');

    return {
      filePath: mediaFilePath,
      fileName: mediaFileName,
      content: stripSubtitleFormatting(content),
      source: 'external',
      language: preferred.language ?? 'unknown',
    };
  } catch {
    return null;
  }
}

async function extractEmbeddedSubtitles(
  mediaFilePath: string,
  mediaFileName: string,
  mediaExt: string,
): Promise<ExtractedSubtitles | null> {
  const tracks = await getSubtitleTracks(mediaFilePath);
  if (tracks.length === 0) return null;

  const englishTrack = tracks.find(
    (t) => t.language && /^en/i.test(t.language),
  );
  const targetTrack = englishTrack ?? tracks[0];

  const isMkv = mediaExt === '.mkv';

  try {
    const content = isMkv
      ? await extractWithMkvextract(mediaFilePath, targetTrack.index)
      : await extractWithFfmpeg(mediaFilePath, targetTrack.index);

    if (!content) return null;

    return {
      filePath: mediaFilePath,
      fileName: mediaFileName,
      content: stripSubtitleFormatting(content),
      source: 'embedded',
      language: targetTrack.language ?? 'unknown',
    };
  } catch {
    // If mkvextract fails, try ffmpeg as fallback
    if (isMkv) {
      try {
        const content = await extractWithFfmpeg(
          mediaFilePath,
          targetTrack.index,
        );
        if (!content) return null;

        return {
          filePath: mediaFilePath,
          fileName: mediaFileName,
          content: stripSubtitleFormatting(content),
          source: 'embedded',
          language: targetTrack.language ?? 'unknown',
        };
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function getSubtitleTracks(
  filePath: string,
): Promise<SubtitleTrack[]> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_streams',
    '-select_streams',
    's',
    filePath,
  ]);

  const probe = JSON.parse(stdout);
  const streams = probe.streams ?? [];

  return streams.map(
    (stream: Record<string, unknown>, index: number): SubtitleTrack => ({
      index,
      language: (stream.tags as Record<string, string>)?.language,
      title: (stream.tags as Record<string, string>)?.title,
      format: (stream.codec_name as string) ?? 'unknown',
    }),
  );
}

async function extractWithMkvextract(
  filePath: string,
  trackIndex: number,
): Promise<string | null> {
  const tempDir = await mkdtemp(join(tmpdir(), 'seraex-subs-'));
  const outputPath = join(tempDir, `track_${trackIndex}.srt`);

  try {
    await execFileAsync('mkvextract', [
      'tracks',
      filePath,
      `${trackIndex}:${outputPath}`,
    ]);

    const content = await readFile(outputPath, 'utf-8');
    return content;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function extractWithFfmpeg(
  filePath: string,
  trackIndex: number,
): Promise<string | null> {
  const tempDir = await mkdtemp(join(tmpdir(), 'seraex-subs-'));
  const outputPath = join(tempDir, `sub_${trackIndex}.srt`);

  try {
    await execFileAsync('ffmpeg', [
      '-v',
      'quiet',
      '-i',
      filePath,
      '-map',
      `0:s:${trackIndex}`,
      '-f',
      'srt',
      outputPath,
    ]);

    const content = await readFile(outputPath, 'utf-8');
    return content;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// ── Formatting Helpers ───────────────────────────────────────────────

function stripSubtitleFormatting(content: string): string {
  let text = content;

  // Remove ASS/SSA header sections
  text = text.replace(/\[Script Info\][\s\S]*?\[Events\]\s*/i, '');
  text = text.replace(/Format:.*?\n/gi, '');

  // Remove ASS/SSA dialogue prefix
  text = text.replace(
    /Dialogue:\s*\d+,[\d:.]+,[\d:.]+,[^,]*(?:,[^,]*){4},/g,
    '',
  );

  // Remove ASS override tags like {\an8}, {\pos(x,y)}, etc.
  text = text.replace(/\{\\[^}]*\}/g, '');

  // Remove SRT sequence numbers and timestamps
  text = text.replace(/^\d+\s*$/gm, '');
  text = text.replace(
    /\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/g,
    '',
  );

  // Remove HTML-style tags
  text = text.replace(/<[^>]+>/g, '');

  // Clean up whitespace
  text = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');

  return text;
}

function replaceExtension(fileName: string, newExt: string): string {
  const base = basename(fileName, extname(fileName));
  return base + newExt;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
