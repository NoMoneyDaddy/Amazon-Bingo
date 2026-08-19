import { parentPort } from 'node:worker_threads';
import {
  forecastEvaluation,
  calibratedProbabilityEvaluation,
  profitabilityEvaluation,
  zoneProfitabilityEvaluation,
  technicalAnalysis,
} from './server.mjs';

parentPort.on('message', ({ requestId, history, runId }) => {
  try {
    const report = (stage, percent, message) => parentPort.postMessage({
      requestId,
      runId,
      progress: { stage, percent, message },
    });

    report('forecast-evaluation', 74, '評估逐期預測結果');
    const forecast = forecastEvaluation(history);
    report('probability-calibration', 78, '校準預測機率與評分');
    const calibrated = calibratedProbabilityEvaluation(history);
    report('profitability-backtest', 83, '計算各玩法樣本外盈利回測');
    const profitability = profitabilityEvaluation(history);
    report('zone-backtest', 87, '分析分區選號回測結果');
    const zones = zoneProfitabilityEvaluation(history);
    report('technical-analysis', 91, '整理技術分析與隨機性審計');
    const technical = technicalAnalysis(history);
    parentPort.postMessage({
      requestId,
      evaluation: {
        forecastEvaluation: forecast,
        calibratedProbabilityEvaluation: calibrated,
        profitabilityEvaluation: profitability,
        zoneProfitabilityEvaluation: zones,
        technicalAnalysis: technical,
      },
    });
  } catch (error) {
    parentPort.postMessage({ requestId, error: error instanceof Error ? error.message : '評估計算失敗' });
  }
});
