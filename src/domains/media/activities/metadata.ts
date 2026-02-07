import type {
  AnimeSearchResult,
  AnimeEpisode,
  SeasonInfo,
  SeriesMetadata,
} from '../../../shared/types';

const ANILIST_API = 'https://graphql.anilist.co';

/**
 * Fetch full series metadata by searching for the anime name,
 * then traversing the AniList prequel/sequel relation chain to
 * discover all TV seasons and their per-season episode lists.
 */
export async function fetchSeriesMetadata(
  folderName: string,
): Promise<SeriesMetadata | null> {
  const searchQuery = cleanFolderName(folderName);

  // Find the initial match
  const initialAnime = await searchAnime(searchQuery);
  if (!initialAnime) {
    console.warn(
      `No anime found for: "${searchQuery}" (from folder: "${folderName}")`,
    );
    return null;
  }

  // Walk backwards to the first season
  const firstSeason = await walkToFirstSeason(initialAnime.anilistId);

  // Walk forwards to collect all TV seasons
  const seasonEntries = await collectAllSeasons(firstSeason);

  // Fetch episode lists for each season
  const seasons: SeasonInfo[] = [];
  for (let i = 0; i < seasonEntries.length; i++) {
    const entry = seasonEntries[i];
    const episodes = await fetchEpisodes(entry.anilistId, entry.episodeCount);
    seasons.push({
      seasonNumber: i + 1,
      anilistId: entry.anilistId,
      title: entry.title,
      episodeCount: entry.episodeCount,
      episodes,
    });
  }

  const totalCoreEpisodes = seasons.reduce(
    (sum, s) => sum + s.episodeCount,
    0,
  );

  // Use the first season's English or romaji title as the canonical series name
  const seriesName =
    seasons[0]?.title.english ?? seasons[0]?.title.romaji ?? folderName;

  return { seriesName, seasons, totalCoreEpisodes };
}

// ── AniList GraphQL helpers ─────────────────────────────────────────

interface MinimalAnimeEntry {
  anilistId: number;
  title: { romaji: string; english: string | null };
  episodeCount: number;
  format: string;
}

/**
 * Search AniList for an anime matching the given query.
 */
async function searchAnime(query: string): Promise<AnimeSearchResult | null> {
  const graphqlQuery = `
    query ($search: String) {
      Media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
        id
        title {
          romaji
          english
          native
        }
        episodes
        format
        status
        season
        seasonYear
      }
    }
  `;

  const response = await fetch(ANILIST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: graphqlQuery,
      variables: { search: query },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `AniList API error: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    data?: { Media?: Record<string, unknown> };
    errors?: Array<{ message: string }>;
  };

  if (data.errors?.length) {
    if (data.errors.some((e) => e.message.includes('Not Found'))) {
      return null;
    }
    throw new Error(`AniList query error: ${data.errors[0].message}`);
  }

  const media = data.data?.Media;
  if (!media) return null;

  return {
    anilistId: media.id as number,
    title: media.title as AnimeSearchResult['title'],
    episodes: media.episodes as number | null,
    format: media.format as string,
    status: media.status as string,
    season: media.season as string | undefined,
    seasonYear: media.seasonYear as number | undefined,
  };
}

/**
 * Walk PREQUEL relations backwards from a given AniList ID to find the
 * very first TV season in the franchise.
 */
async function walkToFirstSeason(startId: number): Promise<number> {
  let currentId = startId;
  const visited = new Set<number>();

  while (!visited.has(currentId)) {
    visited.add(currentId);
    const relations = await fetchRelations(currentId);
    const prequel = relations.find(
      (r) => r.relationType === 'PREQUEL' && r.format === 'TV',
    );
    if (!prequel) break;
    currentId = prequel.anilistId;
  }

  return currentId;
}

/**
 * Starting from the first season ID, walk SEQUEL relations forwards
 * to collect all TV seasons in order.
 */
async function collectAllSeasons(
  firstSeasonId: number,
): Promise<MinimalAnimeEntry[]> {
  const seasons: MinimalAnimeEntry[] = [];
  let currentId: number | null = firstSeasonId;
  const visited = new Set<number>();

  while (currentId !== null && !visited.has(currentId)) {
    visited.add(currentId);
    const entry = await fetchMinimalEntry(currentId);
    if (!entry) break;

    // Only include TV format entries (skip OVAs, movies, specials)
    if (entry.format === 'TV') {
      seasons.push(entry);
    }

    // Find the sequel
    const relations = await fetchRelations(currentId);
    const sequel = relations.find(
      (r) => r.relationType === 'SEQUEL' && r.format === 'TV',
    );
    currentId = sequel?.anilistId ?? null;
  }

  return seasons;
}

interface RelationEdge {
  relationType: string;
  anilistId: number;
  format: string;
}

/**
 * Fetch the relations (prequel/sequel edges) for a given AniList media ID.
 */
async function fetchRelations(mediaId: number): Promise<RelationEdge[]> {
  const graphqlQuery = `
    query ($id: Int) {
      Media(id: $id) {
        relations {
          edges {
            relationType
            node {
              id
              format
            }
          }
        }
      }
    }
  `;

  const response = await fetch(ANILIST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: graphqlQuery,
      variables: { id: mediaId },
    }),
  });

  if (!response.ok) return [];

  const data = (await response.json()) as {
    data?: {
      Media?: {
        relations?: {
          edges: Array<{
            relationType: string;
            node: { id: number; format: string };
          }>;
        };
      };
    };
  };

  const edges = data.data?.Media?.relations?.edges ?? [];
  return edges.map((edge) => ({
    relationType: edge.relationType,
    anilistId: edge.node.id,
    format: edge.node.format,
  }));
}

/**
 * Fetch minimal anime entry data (title, episode count, format) by ID.
 */
async function fetchMinimalEntry(
  mediaId: number,
): Promise<MinimalAnimeEntry | null> {
  const graphqlQuery = `
    query ($id: Int) {
      Media(id: $id) {
        id
        title {
          romaji
          english
        }
        episodes
        format
      }
    }
  `;

  const response = await fetch(ANILIST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: graphqlQuery,
      variables: { id: mediaId },
    }),
  });

  if (!response.ok) return null;

  const data = (await response.json()) as {
    data?: {
      Media?: {
        id: number;
        title: { romaji: string; english: string | null };
        episodes: number | null;
        format: string;
      };
    };
  };

  const media = data.data?.Media;
  if (!media) return null;

  return {
    anilistId: media.id,
    title: { romaji: media.title.romaji, english: media.title.english },
    episodeCount: media.episodes ?? 0,
    format: media.format,
  };
}

/**
 * Fetch episode list with titles for a single season.
 */
async function fetchEpisodes(
  anilistId: number,
  expectedCount: number,
): Promise<AnimeEpisode[]> {
  const graphqlQuery = `
    query ($mediaId: Int) {
      Media(id: $mediaId) {
        episodes
        streamingEpisodes {
          title
          thumbnail
        }
        airingSchedule(notYetAired: false, perPage: 50) {
          nodes {
            episode
            airingAt
          }
        }
      }
    }
  `;

  const response = await fetch(ANILIST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: graphqlQuery,
      variables: { mediaId: anilistId },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `AniList API error: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    data?: {
      Media?: {
        episodes: number | null;
        streamingEpisodes: Array<{ title: string; thumbnail: string }>;
        airingSchedule: {
          nodes: Array<{ episode: number; airingAt: number }>;
        };
      };
    };
  };

  const media = data.data?.Media;
  if (!media) return [];

  const episodes: AnimeEpisode[] = [];
  const episodeCount =
    expectedCount ||
    media.episodes ||
    media.airingSchedule.nodes.length ||
    0;

  // Use streaming episodes if available (they often have episode titles)
  if (media.streamingEpisodes.length > 0) {
    for (let i = 0; i < media.streamingEpisodes.length; i++) {
      const streamEp = media.streamingEpisodes[i];
      const title = parseStreamingEpisodeTitle(streamEp.title);
      episodes.push({
        number: title.number ?? i + 1,
        title: title.cleanTitle,
        description: null,
      });
    }
  } else {
    // Fall back to generating numbered episodes
    for (let i = 1; i <= episodeCount; i++) {
      episodes.push({
        number: i,
        title: null,
        description: null,
      });
    }
  }

  episodes.sort((a, b) => a.number - b.number);
  return episodes;
}

/**
 * Parse a streaming episode title like "Episode 1 - The Beginning"
 * into its components.
 */
function parseStreamingEpisodeTitle(
  title: string,
): { number: number | null; cleanTitle: string } {
  const patterns = [
    /^(?:Episode|EP|Ep\.?)\s*(\d+)\s*[-:．.]\s*(.+)$/i,
    /^(\d+)\s*[-:．.]\s*(.+)$/,
    /^(?:Episode|EP|Ep\.?)\s*(\d+)$/i,
  ];

  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) {
      return {
        number: parseInt(match[1], 10),
        cleanTitle: match[2]?.trim() ?? title.trim(),
      };
    }
  }

  return { number: null, cleanTitle: title.trim() };
}

/**
 * Clean a folder name for anime search.
 * Removes common patterns like resolution, codec info, release group tags.
 */
function cleanFolderName(name: string): string {
  let cleaned = name;

  // Remove bracket content: [SubGroup], [1080p], etc.
  cleaned = cleaned.replace(/\[[^\]]*\]/g, '');

  // Remove parenthetical content: (2024), (BD), etc.
  cleaned = cleaned.replace(/\([^)]*\)/g, '');

  // Remove common quality/codec indicators
  cleaned = cleaned.replace(
    /\b(1080p|720p|480p|2160p|4K|x264|x265|HEVC|AVC|FLAC|AAC|BD|BluRay|BDRip|WEB-DL|WEBRip)\b/gi,
    '',
  );

  // Remove season indicators and normalize (keep for search context)
  // "Anime Name S2" -> "Anime Name Season 2"
  cleaned = cleaned.replace(/\bS(\d+)\b/gi, 'Season $1');

  // Replace common separators with spaces
  cleaned = cleaned.replace(/[_.-]+/g, ' ');

  // Collapse multiple spaces and trim
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}
