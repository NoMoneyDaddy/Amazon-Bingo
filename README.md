# 賓果玄學研究台

CubeLV 插件與 Zeabur 後端服務，提供台灣彩券 BINGO BINGO 官方開獎資料同步、固定規則研究模型與歷史勝率統計。

## 目錄

- `frontend/`：CubeLV 插件原始碼
- `backend/`：Node.js API 與 Zeabur Docker 部署檔

## 後端 API

- `GET /health`：服務健康檢查
- `GET /api/latest`：向台灣彩券官方頁面取得最新開獎資料並產生研究模型

## 本機啟動

```bash
cd backend
npm start
curl http://localhost:8080/health
```

服務使用 `PORT` 環境變數，預設為 `8080`；可用 `CORS_ORIGIN` 限制前端來源。

## Zeabur

服務根目錄應指向 `backend/`，使用其中的 `Dockerfile` 建置。部署後將公開網址提供給 CubeLV 插件串接。

## 研究邊界

本專案僅供研究與娛樂，不保證中獎、不提供投注或個人化買賣指令。模型是固定規則轉換，勝率必須以累積樣本解讀。
