/**
 * Worker contract. Both the local executor and the Computer adapter
 * implement this. The dispatcher engine never knows which it's calling.
 */

import type { CockpitContext } from '../context/types.js';
import type { CockpitJob, WorkerResult } from '../dispatcher/types.js';

export interface CockpitWorker {
  /** Stable worker id; matches the value in `job.worker`. */
  readonly id: 'local' | 'computer';

  /**
   * Execute one attempt of `job`. Must not throw; pack failures into
   * WorkerResult.error with `fatal` set when retrying would be pointless.
   */
  run(job: CockpitJob, ctx: CockpitContext): Promise<WorkerResult>;
}
