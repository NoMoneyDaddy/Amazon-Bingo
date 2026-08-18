import { parentPort, workerData } from 'node:worker_threads';
import { buildModels } from './server.mjs';

try {
  const models = buildModels(workerData.snapshot, workerData.history, workerData.options);
  parentPort.postMessage({ models });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : '模型計算失敗' });
}
