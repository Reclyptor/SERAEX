import { generateObject } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import type {
  ExtractedSubtitles,
  SeriesMetadata,
  MatchResult,
} from '../../../shared/types';

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-3-5-haiku-latest';

/**
 * Safety limit: if total subtitle text across all files exceeds this many
 * characters, each file is proportionally truncated so that the total fits.
 * 500k chars is well within the 200k token context window for typical subtitle
 * text (roughly 4 chars per token).
 */
const MAX_TOTAL_CHARS = 500_000;

/** Zod schema for the LLM episode matching output */
const EpisodeMatchSchema = z.object({
  matches: z.array(
    z.object({
      fileName: z.string().describe('The original file name'),
      seasonNumber: z
        .number()
        .int()
        .positive()
        .describe('The matched season number (1-indexed)'),
      episodeNumber: z
        .number()
        .int()
        .positive()
        .describe(
          'The matched episode number within the season (1-indexed)',
        ),
      episodeTitle: z
        .string()
        .describe('The episode title from the metadata'),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .describe('Confidence score: 1.0 = certain, 0.0 = guess'),
      reasoning: z
        .string()
        .describe('Brief explanation of why this match was chosen'),
    }),
  ),
});

/**
 * Use an LLM to match extracted subtitles against known episode metadata
 * spanning all seasons of a series.
 * Returns confidence-scored mappings (season + episode) for each file.
 */
export async function matchEpisodes(
  subtitles: ExtractedSubtitles[],
  metadata: SeriesMetadata,
): Promise<MatchResult> {
  const seriesName = metadata.seriesName;

  // Build the episode reference grouped by season
  const episodeReference = metadata.seasons
    .map((season) => {
      const seasonNum = String(season.seasonNumber).padStart(2, '0');
      const seasonTitle =
        season.title.english ?? season.title.romaji ?? `Season ${season.seasonNumber}`;
      const header = `## Season ${season.seasonNumber}: "${seasonTitle}" (${season.episodeCount} episodes)`;

      const episodeLines = season.episodes
        .map((ep) => {
          const epNum = String(ep.number).padStart(2, '0');
          const parts = [`S${seasonNum}E${epNum}`];
          if (ep.title) parts.push(`"${ep.title}"`);
          if (ep.description) parts.push(`- ${ep.description}`);
          return parts.join(' ');
        })
        .join('\n');

      return `${header}\n${episodeLines}`;
    })
    .join('\n\n');

  // Build file snippets — send full subtitle text with proportional safety limit
  const totalChars = subtitles.reduce(
    (sum, sub) => sum + sub.content.length,
    0,
  );
  const needsTruncation = totalChars > MAX_TOTAL_CHARS;

  const fileSnippets = subtitles
    .map((sub) => {
      let content = sub.content;
      if (needsTruncation) {
        const allowedChars = Math.floor(
          (sub.content.length / totalChars) * MAX_TOTAL_CHARS,
        );
        content = sub.content.slice(0, allowedChars);
      }
      return `### File: ${sub.fileName}\n${content}`;
    })
    .join('\n\n');

  const { object } = await generateObject({
    model: anthropic(ANTHROPIC_MODEL),
    schema: EpisodeMatchSchema,
    prompt: `You are an anime episode identification expert. Given subtitle text from video files and a list of known episodes across all seasons for the anime series "${seriesName}", determine which season and episode each file corresponds to.

## Known Episodes for "${seriesName}"
${episodeReference}

## Files with Subtitle Text
${fileSnippets}

## Instructions
- Match each file to a specific season and episode number based on dialogue content, character interactions, and plot points
- The season number and episode number must correspond to the episode reference above (e.g., S01E03 means seasonNumber=1, episodeNumber=3)
- Set confidence to 1.0 if you are certain (strong dialogue/plot evidence)
- Set confidence to 0.7-0.9 if you are fairly confident but not certain
- Set confidence to 0.3-0.6 if you are making an educated guess
- Set confidence below 0.3 if you are mostly guessing
- If episode titles or descriptions are available, use them to improve matching
- Each file should be matched to exactly one episode
- Do not assign the same season+episode to multiple files unless you are confident they are duplicates
- Provide brief reasoning for each match`,
  });

  // Attach file paths from original subtitles
  const result: MatchResult = {
    matches: object.matches.map((match) => {
      const originalSub = subtitles.find(
        (s) => s.fileName === match.fileName,
      );
      return {
        ...match,
        filePath: originalSub?.filePath ?? '',
      };
    }),
  };

  return result;
}
