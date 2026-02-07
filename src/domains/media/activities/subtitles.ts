import { execFile } from 'child_process';
import { readFile, readdir, stat, mkdtemp, rm } from 'fs/promises';
import { join, basename, extname, dirname } from 'path';
import { tmpdir } from 'os';
import { promisify } from 'util';
import type {
  MediaFile,
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

/**
 * Filter files in a directory by minimum duration using ffprobe.
 * Returns MediaFile objects for files that meet the duration threshold.
 */
export async function filterByDuration(
  filePaths: string[],
  minDurationMinutes: number,
): Promise<MediaFile[]> {
  const minDurationSeconds = minDurationMinutes * 60;
  const results: MediaFile[] = [];

  for (const filePath of filePaths) {
    const ext = extname(filePath).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext)) continue;

    try {
      const duration = await getVideoDuration(filePath);
      if (duration >= minDurationSeconds) {
        results.push({
          path: filePath,
          fileName: basename(filePath),
          extension: ext,
          durationSeconds: duration,
        });
      }
    } catch {
      // Skip files that ffprobe can't read
      console.warn(`Could not probe file: ${filePath}`);
    }
  }

  return results;
}

/**
 * Get video duration in seconds using ffprobe.
 */
async function getVideoDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    filePath,
  ]);

  const probe = JSON.parse(stdout);
  const duration = parseFloat(probe.format?.duration ?? '0');
  return duration;
}

/**
 * Get subtitle track information from a video file using ffprobe.
 */
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

/**
 * Extract subtitles from a media file.
 * Tries embedded subtitles first (preferring English), then falls back to external subtitle files.
 */
export async function extractSubtitles(
  mediaFile: MediaFile,
): Promise<ExtractedSubtitles | null> {
  // First, try to find external subtitle files
  const externalSubs = await findExternalSubtitles(mediaFile);
  if (externalSubs) return externalSubs;

  // Fall back to embedded subtitles
  return extractEmbeddedSubtitles(mediaFile);
}

/**
 * Find and read external subtitle files matching the video file.
 */
async function findExternalSubtitles(
  mediaFile: MediaFile,
): Promise<ExtractedSubtitles | null> {
  const dir = dirname(mediaFile.path);
  const baseName = basename(mediaFile.fileName, mediaFile.extension);

  try {
    const entries = await readdir(dir);

    // Look for subtitle files that match the video file name
    // Priority: .eng.srt > .srt > .eng.ass > .ass > any subtitle
    const subtitleFiles: Array<{ path: string; language?: string }> = [];

    for (const entry of entries) {
      const ext = extname(entry).toLowerCase();
      if (!SUBTITLE_EXTENSIONS.has(ext)) continue;

      const entryBase = basename(entry, ext);
      // Match if the subtitle file starts with the video base name
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
      filePath: mediaFile.path,
      fileName: mediaFile.fileName,
      content: stripSubtitleFormatting(content),
      source: 'external',
      language: preferred.language ?? 'unknown',
    };
  } catch {
    return null;
  }
}

/**
 * Extract embedded subtitles from a video file.
 * Tries mkvextract for MKV files, falls back to ffmpeg.
 */
async function extractEmbeddedSubtitles(
  mediaFile: MediaFile,
): Promise<ExtractedSubtitles | null> {
  const tracks = await getSubtitleTracks(mediaFile.path);
  if (tracks.length === 0) return null;

  // Prefer English track, then fall back to first track
  const englishTrack = tracks.find(
    (t) => t.language && /^en/i.test(t.language),
  );
  const targetTrack = englishTrack ?? tracks[0];

  const isMkv = mediaFile.extension.toLowerCase() === '.mkv';

  try {
    const content = isMkv
      ? await extractWithMkvextract(mediaFile.path, targetTrack.index)
      : await extractWithFfmpeg(mediaFile.path, targetTrack.index);

    if (!content) return null;

    return {
      filePath: mediaFile.path,
      fileName: mediaFile.fileName,
      content: stripSubtitleFormatting(content),
      source: 'embedded',
      language: targetTrack.language ?? 'unknown',
    };
  } catch {
    // If mkvextract fails, try ffmpeg as fallback
    if (isMkv) {
      try {
        const content = await extractWithFfmpeg(
          mediaFile.path,
          targetTrack.index,
        );
        if (!content) return null;

        return {
          filePath: mediaFile.path,
          fileName: mediaFile.fileName,
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

/**
 * Extract a subtitle track using mkvextract.
 */
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

/**
 * Extract a subtitle track using ffmpeg.
 */
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

/**
 * Strip subtitle formatting (ASS tags, SRT timestamps) to get plain dialogue text.
 * This is what gets sent to the LLM for matching.
 */
function stripSubtitleFormatting(content: string): string {
  let text = content;

  // Remove ASS/SSA header sections
  text = text.replace(/\[Script Info\][\s\S]*?\[Events\]\s*/i, '');
  text = text.replace(
    /Format:.*?\n/gi,
    '',
  );

  // Remove ASS/SSA dialogue prefix (e.g., "Dialogue: 0,0:01:23.45,0:01:25.67,Default,,0,0,0,,")
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
