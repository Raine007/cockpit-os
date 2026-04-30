import { computerWorker } from './computer.js';
import { localWorker } from './local.js';
import type { CockpitWorker } from './types.js';

const REGISTRY: Record<CockpitWorker['id'], CockpitWorker> = {
  local: localWorker,
  computer: computerWorker,
};

export function getWorker(id: CockpitWorker['id']): CockpitWorker {
  return REGISTRY[id];
}

export type { CockpitWorker } from './types.js';
export { localWorker, computerWorker };
export { setComputerWorkerClientForTesting } from './computer.js';
