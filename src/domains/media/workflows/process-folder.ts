import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
} from '@temporalio/workflow';

import type * as subtitleActivities from '../activities/subtitles';
import type * as llmActivities from '../activities/llm';
import type * as filesystemActivities from '../activities/filesystem';

type Activities = typeof subtitleActivities &
  typeof llmActivities &
  typeof filesystemActivities;

import type {
  ProcessFolderInput,
  ProcessFolderResult,
  ProcessFolderProgress,
  ReviewItem,
  ReviewDecision,
  DetectionConfirmation,
  RenamedFile,
  EpisodeMatch,
  FolderStatus,
  SourceFileInfo,
  ExtractedSubtitles,
} from '../../../shared/types';

// ── Activity proxies ─────────────────────────────────────────────────

const { detectEpisodeFiles, extractSubtitleToDir } =
  proxyActivities<Activities>({
    startToCloseTimeout: '10 minutes',
    retry: { maximumAttempts: 3, initialInterval: '5 seconds', backoffCoefficient: 2 },
  });

const { matchEpisodes } = proxyActivities<Activities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 3, initialInterval: '5 seconds', backoffCoefficient: 2 },
});

const { copyEpisodeToWorkDir } = proxyActivities<Activities>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 2 },
});

// ── Signals & Queries ────────────────────────────────────────────────

export const reviewDecisionSignal =
  defineSignal<[ReviewDecision]>('reviewDecision');
export const detectionConfirmationSignal =
  defineSignal<[DetectionConfirmation]>('detectionConfirmation');
export const getProgressQuery =
  defineQuery<ProcessFolderProgress>('getProgress');

// ── Workflow ─────────────────────────────────────────────────────────

/**
 * Process a single disc folder:
 * 1. Detect episode files via file-size clustering
 * 2. If detection confidence is low/medium, wait for user confirmation
 * 3. Extract subtitles (stored persistently in _subtitles/)
 * 4. Match episodes via LLM
 * 5. Copy-rename high-confidence matches to _episodes/ (idempotent)
 * 6. Block on low-confidence matches until each is approved via HITL
 *
 * Does NOT move files to staging — the parent workflow handles that.
 */
export async function processFolder(
  input: ProcessFolderInput,
): Promise<ProcessFolderResult> {
  const { seriesMetadata } = input;

  // Use the first season's anime entry for renaming (show name)
  const animeForRename = seriesMetadata.seasons[0]
    ? {
        anilistId: seriesMetadata.seasons[0].anilistId,
        title: {
          romaji: seriesMetadata.seasons[0].title.romaji,
          english: seriesMetadata.seasons[0].title.english,
          native: null,
        },
        episodes: seriesMetadata.seasons[0].episodeCount,
        format: 'TV',
        status: 'FINISHED',
      }
    : null;

  // ── Internal state ──
  let status: FolderStatus = 'scanning';
  let totalVideoFiles: number | undefined;
  let detectedEpisodeCount: number | undefined;
  let detectionConfidence: 'high' | 'medium' | 'low' | undefined;
  let totalEpisodeFiles: number | undefined;
  let subtitlesExtracted = 0;
  let currentFile: string | undefined;
  let matchesFound: number | undefined;
  let totalToMatch: number | undefined;
  let episodesCopied = 0;
  let totalEpisodesToCopy: number | undefined;

  const pendingReviews: ReviewItem[] = [];
  const resolvedReviews = new Map<string, ReviewDecision>();
  const renamedFiles: RenamedFile[] = [];

  // Detection confirmation state
  let detectionConfirmed = false;
  let detectionAddedPaths: string[] = [];
  let detectionRemovedPaths: string[] = [];

  // ── Signal handlers ──

  setHandler(reviewDecisionSignal, (decision: ReviewDecision) => {
    resolvedReviews.set(decision.reviewItemId, decision);
  });

  setHandler(
    detectionConfirmationSignal,
    (confirmation: DetectionConfirmation) => {
      detectionConfirmed = true;
      detectionAddedPaths = confirmation.addedPaths ?? [];
      detectionRemovedPaths = confirmation.removedPaths ?? [];
    },
  );

  // ── Progress query handler ──
  setHandler(getProgressQuery, (): ProcessFolderProgress => ({
    folderName: input.folderName,
    status,
    totalVideoFiles,
    detectedEpisodeCount,
    detectionConfidence,
    totalEpisodeFiles,
    subtitlesExtracted,
    currentFile,
    matchesFound,
    totalToMatch,
    episodesCopied,
    totalEpisodesToCopy,
    pendingReviews: pendingReviews.filter(
      (r) =>
        !resolvedReviews.has(r.id) || !resolvedReviews.get(r.id)!.approved,
    ),
  }));

  try {
    // ── Step 1: Detect episodes via file-size clustering ──
    status = 'scanning';
    const detection = await detectEpisodeFiles(input.folderPath);
    totalVideoFiles = detection.episodes.length + detection.nonEpisodes.length;
    detectedEpisodeCount = detection.episodes.length;
    detectionConfidence = detection.confidence;

    let episodeFiles: SourceFileInfo[] = [...detection.episodes];

    // ── Step 2: If confidence is not high, wait for user confirmation ──
    if (detection.confidence !== 'high' && detection.episodes.length > 0) {
      status = 'awaiting_detection_review';
      await condition(() => detectionConfirmed);

      // Apply user corrections
      if (detectionRemovedPaths.length > 0) {
        const removeSet = new Set(detectionRemovedPaths);
        episodeFiles = episodeFiles.filter((f) => !removeSet.has(f.path));
      }
      if (detectionAddedPaths.length > 0) {
        const addSet = new Set(detectionAddedPaths);
        const addedFiles = detection.nonEpisodes.filter((f) =>
          addSet.has(f.path),
        );
        episodeFiles.push(...addedFiles);
      }

      detectedEpisodeCount = episodeFiles.length;
    }

    if (episodeFiles.length === 0) {
      status = 'completed';
      return {
        folderName: input.folderName,
        status: 'completed',
        episodesFound: 0,
        episodesRenamed: 0,
        episodesPendingReview: 0,
        renamedFiles: [],
        episodeOriginalPaths: [],
        unprocessedFiles: [],
      };
    }

    // ── Step 3: Extract subtitles (persistent, idempotent) ──
    status = 'extracting';
    totalEpisodeFiles = episodeFiles.length;
    subtitlesExtracted = 0;

    const subtitlesDir = `${input.seriesRootDir}/_subtitles/${input.folderName}`;
    const extractedSubtitles: ExtractedSubtitles[] = [];

    for (const file of episodeFiles) {
      currentFile = file.name;
      const subs = await extractSubtitleToDir(
        file.path,
        file.name,
        subtitlesDir,
      );
      if (subs) {
        extractedSubtitles.push(subs);
      }
      subtitlesExtracted++;
    }
    currentFile = undefined;

    if (extractedSubtitles.length === 0) {
      status = 'failed';
      return {
        folderName: input.folderName,
        status: 'failed',
        episodesFound: episodeFiles.length,
        episodesRenamed: 0,
        episodesPendingReview: 0,
        renamedFiles: [],
        episodeOriginalPaths: episodeFiles.map((f) => f.path),
        unprocessedFiles: episodeFiles.map((f) => f.path),
        error: 'Could not extract subtitles from any file',
      };
    }

    // ── Step 4: Match episodes via LLM ──
    status = 'matching';
    totalToMatch = extractedSubtitles.length;
    const matchResult = await matchEpisodes(extractedSubtitles, seriesMetadata);
    matchesFound = matchResult.matches.length;

    // ── Step 5: Split matches by confidence and copy-rename ──
    status = 'renaming';
    const highConfidence: EpisodeMatch[] = [];
    const lowConfidence: EpisodeMatch[] = [];

    for (const match of matchResult.matches) {
      if (match.confidence >= input.confidenceThreshold) {
        highConfidence.push(match);
      } else {
        lowConfidence.push(match);
      }
    }

    totalEpisodesToCopy = highConfidence.length + lowConfidence.length;
    episodesCopied = 0;

    // Copy-rename high-confidence matches
    const episodesDir = `${input.seriesRootDir}/_episodes`;
    if (animeForRename) {
      for (const match of highConfidence) {
        currentFile = match.fileName;
        const renamed = await copyEpisodeToWorkDir(
          match,
          animeForRename,
          episodesDir,
          input.seriesRootDir,
          input.dryRun,
        );
        renamedFiles.push(renamed);
        episodesCopied++;
      }
    }
    currentFile = undefined;

    // ── Step 6: HIL for low-confidence matches ──
    if (lowConfidence.length > 0) {
      status = 'awaiting_review';

      const allEpisodes = seriesMetadata.seasons.flatMap((s) => s.episodes);

      for (const match of lowConfidence) {
        const subtitle = extractedSubtitles.find(
          (s) => s.fileName === match.fileName,
        );

        const reviewItem: ReviewItem = {
          id: `${input.folderName}-${match.fileName}`,
          fileName: match.fileName,
          filePath: match.filePath,
          subtitleSnippet: subtitle?.content.slice(0, 500) ?? '',
          suggestedSeasonNumber: match.seasonNumber,
          suggestedEpisodeNumber: match.episodeNumber,
          suggestedEpisodeTitle: match.episodeTitle,
          confidence: match.confidence,
          reasoning: match.reasoning,
          availableEpisodes: allEpisodes,
          availableSeasons: seriesMetadata.seasons,
        };
        pendingReviews.push(reviewItem);
      }

      // Block-finalize: wait for every review to receive an approved decision
      for (const review of pendingReviews) {
        while (true) {
          await condition(() => resolvedReviews.has(review.id));

          const decision = resolvedReviews.get(review.id)!;

          if (decision.approved && animeForRename) {
            const seasonNumber =
              decision.correctedSeasonNumber ??
              review.suggestedSeasonNumber;
            const episodeNumber =
              decision.correctedEpisodeNumber ??
              review.suggestedEpisodeNumber;

            const season = seriesMetadata.seasons.find(
              (s) => s.seasonNumber === seasonNumber,
            );
            const episodeTitle =
              season?.episodes.find((e) => e.number === episodeNumber)
                ?.title ?? `Episode ${episodeNumber}`;

            const correctedMatch: EpisodeMatch = {
              fileName: review.fileName,
              filePath: review.filePath,
              seasonNumber,
              episodeNumber,
              episodeTitle,
              confidence: 1.0,
              reasoning: 'User-approved',
            };

            currentFile = review.fileName;
            const renamed = await copyEpisodeToWorkDir(
              correctedMatch,
              animeForRename,
              episodesDir,
              input.seriesRootDir,
              input.dryRun,
            );
            renamedFiles.push(renamed);
            episodesCopied++;
            currentFile = undefined;
            break;
          }

          if (!animeForRename) break;

          // Not approved: clear the decision so the user can resubmit
          resolvedReviews.delete(review.id);
        }
      }
    }

    // Collect all original episode paths for the parent workflow
    const episodeOriginalPaths = episodeFiles.map((f) => f.path);

    // Determine unprocessed files
    const renamedOriginalPaths = new Set(
      renamedFiles.map((r) => r.originalPath),
    );
    const unprocessedFiles = episodeFiles
      .map((f) => f.path)
      .filter((p) => !renamedOriginalPaths.has(p));

    status = 'completed';
    return {
      folderName: input.folderName,
      status: 'completed',
      episodesFound: episodeFiles.length,
      episodesRenamed: renamedFiles.length,
      episodesPendingReview: 0,
      renamedFiles,
      episodeOriginalPaths,
      unprocessedFiles,
    };
  } catch (err) {
    status = 'failed';
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      folderName: input.folderName,
      status: 'failed',
      episodesFound: totalVideoFiles ?? 0,
      episodesRenamed: renamedFiles.length,
      episodesPendingReview: pendingReviews.filter(
        (r) =>
          !resolvedReviews.has(r.id) ||
          !resolvedReviews.get(r.id)!.approved,
      ).length,
      renamedFiles,
      episodeOriginalPaths: [],
      unprocessedFiles: [],
      error: errorMessage,
    };
  }
}
