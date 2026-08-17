import { Plugin, plugin, View, useItemsByType } from '@cubelv/sdk';
import { BingoResearchFolder, BingoDraw } from './schemas/bingoResearchSchema';
import { BingoResearchView } from './BingoResearchView';

class BingoResearchLeafView extends View {
  getViewType() { return 'bingo-research-dashboard'; }
  getDisplayText() { return '賓果玄學研究台'; }
  renderComponent() { return <BingoResearchView />; }
}

function useBingoSidebarData() {
  return { items: useItemsByType('BINGO_RESEARCH_FOLDER') };
}

@plugin('6cf51818eb21290a21a4e8ac', {
  description: '台灣彩券賓果賓果即時紀錄、玄學模型預測與玩法勝率研究',
  dependencies: ['Sidebar'],
})
export class BingoResearchPlugin extends Plugin {
  onload() {
    this.registerPluginRoot('bingoResearch');
    this.registerSection({
      id: 'bingoResearch',
      title: '賓果玄學研究台',
      orderAt: 760,
      useData: useBingoSidebarData,
    });
    this.registerFolderType(BingoResearchFolder, {
      folderIcon: 'test-tubes',
      views: [{ type: 'bingo-research-dashboard', creator: (leaf) => new BingoResearchLeafView(leaf) }],
      panes: { centerPane2: { leafId: 'leaf-bingo-research', viewType: 'bingo-research-dashboard', flex: 1 } },
      children: [{ class: BingoDraw, icon: 'history', displayText: (item) => (item as BingoDraw).period }],
    });
  }
}
