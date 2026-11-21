# Issue-001 空 catch 吞掉所有錯誤

狀態：錯誤回報已接上（`services/errors.ts`），剩測試。

## 問題

多處 `try { … } catch {}` 以「不影響主流程」為理由吞掉錯誤，沒有任何紀錄：

- `state/playerStore.ts` 的 store 與 progress 通知迴圈
- `state/playerStore.ts` 的彈幕載入
- `state/playerStore.ts` 開片前的清理、停止時的錯誤
- `services/storage.ts` 的 storage 變更 listener
- `services/localProxy.ts` 的提示與停止錯誤
- `services/auth.ts` 的 WebView 注入

## 影響

真正的 bug（型別錯誤、原生 API 失敗）在現場完全看不到痕跡，只能靠使用者回報。清理與通知是每次換片都會走的路徑，錯誤會被放大成「偶爾黑屏」「進度不更新」。

## 驗收

- 建立 single place 的錯誤回報（至少 `console.error` 加上分類標籤）。
- 每個 catch 要嘛回報，要嘛在型別上標明可忽略的原因。
- 新增測試：注入會丟錯的 listener 時，回報有紀錄且其他 listener 照跑。
