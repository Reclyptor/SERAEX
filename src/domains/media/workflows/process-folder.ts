import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
} from '@temporalio/workflow';

import type * as scanActivities from '../activities/scan';
import type * as subtitleActivities from '../activities/subtitles';
import type * as metadataActivities from '../activities/metadata';
import type * as llmActivities from '../activities/llm';
import type * as filesystemActivities from '../activities/filesystem';

type Activities = typeof scanActivities &
  typeof subtitleActivities &
  typeof metadataActivities &
  typeof llmActivities &
  typeof filesystemActivities;

import type {
  ProcessFolderInput,
  ProcessFolderResult,
  ProcessFolderProgress,
  ReviewItem,
  ReviewDecision,
  RenamedFile,
  EpisodeMatch,
  FolderStatus,
} from '../../../shared/types';

// Proxy all media activities with appropriate timeouts
const {
  listFilesRecursive,
  filterByDuration,
  extractSubtitles,
  matchEpisodes,
  renameFile,
} = proxyActivities<Activities>({
  startToCloseTimeout: '10 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
  },
});

// Signals
export const reviewDecisionSignal =
  defineSignal<[ReviewDecision]>('reviewDecision');

// Queries
export const getProgressQuery =
  defineQuery<ProcessFolderProgress>('getProgress');

/**
 * Process a single disc folder:
 * 1. Filter files by duration
 * 2. Extract subtitles
 * 3. Match episodes via LLM (across all seasons using seriesMetadata)
 * 4. Rename high-confidence matches immediately
 * 5. Block on low-confidence matches until each is approved via HITL
 *
 * Season numbers come from the LLM match result (informed by the full
 * series metadata), NOT from the disc directory name.
 *
 * Does NOT move files to output — the parent workflow handles publish.
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

  // Internal state
  let status: FolderStatus = 'scanning';
  let totalFiles = 0;
  let filesProcessed = 0;
  const pendingReviews: ReviewItem[] = [];
  const resolvedReviews = new Map<string, ReviewDecision>();
  const renamedFiles: RenamedFile[] = [];

  // Handle review decision signals
  setHandler(reviewDecisionSignal, (decision: ReviewDecision) => {
    resolvedReviews.set(decision.reviewItemId, decision);
  });

  // Handle progress queries
  setHandler(getProgressQuery, (): ProcessFolderProgress => ({
    folderName: input.folderName,
    status,
    totalFiles,
    filesProcessed,
    pendingReviews: pendingReviews.filter(
      (r) =>
        !resolvedReviews.has(r.id) || !resolvedReviews.get(r.id)!.approved,
    ),
  }));

  try {
    // Step 1: List and filter files by duration
    status = 'scanning';
    const allFiles = await listFilesRecursive(input.folderPath);
    const mediaFiles = await filterByDuration(
      allFiles,
      input.minDurationMinutes,
    );
    totalFiles = mediaFiles.length;

    if (mediaFiles.length === 0) {
      return {
        folderName: input.folderName,
        status: 'completed',
        episodesFound: 0,
        episodesRenamed: 0,
        episodesPendingReview: 0,
        renamedFiles: [],
        unprocessedFiles: [],
      };
    }

    // Step 2: Extract subtitles from each file
    status = 'extracting';
    const extractedSubtitles = [];
    for (const mediaFile of mediaFiles) {
      const subs = await extractSubtitles(mediaFile);
      if (subs) {
        extractedSubtitles.push(subs);
      }
      filesProcessed++;
    }

    if (extractedSubtitles.length === 0) {
      return {
        folderName: input.folderName,
        status: 'failed',
        episodesFound: mediaFiles.length,
        episodesRenamed: 0,
        episodesPendingReview: 0,
        renamedFiles: [],
        unprocessedFiles: mediaFiles.map((f) => f.path),
        error: 'Could not extract subtitles from any file',
      };
    }

    // Step 3: Match episodes via LLM (using full series metadata across all seasons)
    status = 'matching';
    const matchResult = await matchEpisodes(
      extractedSubtitles,
      seriesMetadata,
    );

    // Step 4: Process matches
    status = 'renaming';
    const highConfidence: EpisodeMatch[] = [];
    const lowConfidence: EpisodeMatch[] = [];
    const matchedFilePaths = new Set<string>();

    for (const match of matchResult.matches) {
      matchedFilePaths.add(match.filePath);
      if (match.confidence >= input.confidenceThreshold) {
        highConfidence.push(match);
      } else {
        lowConfidence.push(match);
      }
    }

    // Rename high-confidence matches immediately
    if (animeForRename) {
      for (const match of highConfidence) {
        const renamed = await renameFile(match, animeForRename, input.dryRun);
        renamedFiles.push(renamed);
      }
    }

    // Handle low-confidence matches via HITL (block-finalize)
    if (lowConfidence.length > 0) {
      status = 'awaiting_review';

      // Flatten all episodes across seasons for the review UI
      const allEpisodes = seriesMetadata.seasons.flatMap((s) => s.episodes);

      // Create review items for each low-confidence match
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

      // Block-finalize: wait for every review to receive an approved decision.
      // Rejected decisions are cleared so the user can re-submit with a correction.
      for (const review of pendingReviews) {
        // Loop until this review item is approved
        while (true) {
          await condition(() => resolvedReviews.has(review.id));

          const decision = resolvedReviews.get(review.id)!;

          if (decision.approved && animeForRename) {
            // Use corrected season/episode if provided, else the original suggestion
            const seasonNumber =
              decision.correctedSeasonNumber ??
              review.suggestedSeasonNumber;
            const episodeNumber =
              decision.correctedEpisodeNumber ??
              review.suggestedEpisodeNumber;

            // Find the episode title from the correct season
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
              confidence: 1.0, // User-confirmed
              reasoning: 'User-approved',
            };

            const renamed = await renameFile(
              correctedMatch,
              animeForRename,
              input.dryRun,
            );
            renamedFiles.push(renamed);
            break; // This review is done
          }

          if (!animeForRename) break;

          // Not approved: clear the decision so the user can resubmit
          resolvedReviews.delete(review.id);
        }
      }
    }

    // Determine unprocessed files: video files that weren't matched to any episode
    const renamedOriginalPaths = new Set(
      renamedFiles.map((r) => r.originalPath),
    );
    const unprocessedFiles = mediaFiles
      .map((f) => f.path)
      .filter((p) => !renamedOriginalPaths.has(p));

    status = 'completed';
    return {
      folderName: input.folderName,
      status: 'completed',
      episodesFound: mediaFiles.length,
      episodesRenamed: renamedFiles.length,
      episodesPendingReview: 0,
      renamedFiles,
      unprocessedFiles,
    };
  } catch (err) {
    status = 'failed';
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      folderName: input.folderName,
      status: 'failed',
      episodesFound: totalFiles,
      episodesRenamed: renamedFiles.length,
      episodesPendingReview: pendingReviews.filter(
        (r) =>
          !resolvedReviews.has(r.id) ||
          !resolvedReviews.get(r.id)!.approved,
      ).length,
      renamedFiles,
      unprocessedFiles: [],
      error: errorMessage,
    };
  }
}
