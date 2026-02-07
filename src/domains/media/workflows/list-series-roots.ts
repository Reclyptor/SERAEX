import { proxyActivities } from '@temporalio/workflow';
import type * as scanActivities from '../activities/scan';

const { listSeriesRoots } = proxyActivities<typeof scanActivities>({
  startToCloseTimeout: '30 seconds',
});

/**
 * Lightweight workflow that lists series roots via the scan activity.
 * The activity reads MEDIA_INPUT_ROOT from the worker's own environment.
 * Called by SERA so it doesn't need NFS access.
 */
export async function listSeriesRootsWorkflow(): Promise<
  Array<{ name: string; path: string }>
> {
  return listSeriesRoots();
}
