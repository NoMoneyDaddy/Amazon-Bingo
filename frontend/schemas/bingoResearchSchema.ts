import { BaseItem, itemType } from '@cubelv/sdk';

@itemType('BINGO_RESEARCH_FOLDER', '賓果玄學研究資料夾', { defaultFolder: '賓果玄學研究' })
export class BingoResearchFolder extends BaseItem {}

@itemType('BINGO_DRAW', '賓果賓果開獎紀錄')
export class BingoDraw extends BaseItem {
  /** 官方期別，例如 115046435 */
  period: string = '';
  /** 台灣彩券官方顯示的開獎日期時間 */
  drawAt: string = '';
  /** 20 個獎號，以逗號分隔 */
  numbers: string = '';
  /** 超級獎號；資料缺失時留空 */
  superNumber: string = '';
  /** 官方猜大小結果 */
  size: string = '';
  /** 官方猜單雙結果 */
  oddEven: string = '';
  /** 抓取時間 epoch 毫秒 */
  fetchedAt: number = 0;
  /** 各玄學模型的玩法預測 JSON */
  modelPredictions: string = '';
  /** 同步或解析狀態 */
  syncStatus: string = '';
}
