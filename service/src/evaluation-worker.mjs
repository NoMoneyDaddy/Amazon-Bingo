import { parentPort } from 'node:worker_threads';
import {
  forecastEvaluation,
  calibratedProbabilityEvaluation,
  profitabilityEvaluation,
  zoneProfitabilityEvaluation,
  technicalAnalysis,
} from './server.mjs';

parentPort.on('message', ({ requestId, history }) => {
  try {
    parentPort.postMessage({
      requestId,
      evaluation: {
        forecastEvaluation: forecastEvaluation(history),
        calibratedProbabilityEvaluation: calibratedProbabilityEvaluation(history),
        profitabilityEvaluation: profitabilityEvaluation(history),
        zoneProfitabilityEvaluation: zoneProfitabilityEvaluation(history),
        technicalAnalysis: technicalAnalysis(history),
      },
    });
  } catch (error) {
    parentPort.postMessage({ requestId, error: error instanceof Error ? error.message : '評估計算失敗' });
  }
});
