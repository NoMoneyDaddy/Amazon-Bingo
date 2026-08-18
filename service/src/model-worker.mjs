import { parentPort } from 'node:worker_threads';
import { buildModels } from './server.mjs';

parentPort.on('message', ({ requestId, snapshot, history, options }) => {
  try {
    const models = buildModels(snapshot, history, options);
    parentPort.postMessage({ requestId, models });
  } catch (error) {
    parentPort.postMessage({ requestId, error: error instanceof Error ? error.message : '模型計算失敗' });
  }
});
