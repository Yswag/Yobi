# ADR-0010 Yobi 不寫程式註解

## 狀態

已採用。2026-11。

## 背景

這個專案原本有 1,122 行註解（佔產品程式碼 5.8%），其中大量是解釋「為什麼這樣寫」。這些內容有價值，但放錯位置：註解會跟程式碼一起腐化，重構後留下半真的說明，而且讓 agent 有藉口把 hack 寫進去再用一行註解開脫。

## 決策

1. 產品程式碼不寫註解。`index.tsx`、`components/`、`services/`、`state/`、`types/`、`ui/`、`utils/`、`views/` 一律禁止行註解與區塊註解。
2. 決策寫進 `docs/adr/`。一個決定一份 ADR，內容是「選了什麼、為什麼、代價」，不寫開發歷史。
3. 偷懶實作不寫註解開脫，開 issue。issue 放在 `docs/issues/`，描述要修的行為，不是描述現況；修完就刪掉該檔，不留歷史。
4. 例外只有三種：產生檔的授權標頭（`services/youtube/vendor/`）、工具指令（例如 `// @ts-expect-error`）、與 lint 自身的 baseline 檔。
5. 用 lint 守門，採 ratchet：`tools/lint-comments.mjs` 會列出所有違規；`tools/comment-baseline.json` 記下目前允許的上限。只能往下調，不能往上加。

## 後果

- 好處：看不出意圖的程式碼會被迫改名、拆小或補型別，而不是補一行註解。
- 代價：ADR 可能與程式碼不同步。緩解方式是 ADR 只寫「決策與理由」，細節留給型別與測試。
- 想再跑一次同樣的清理，用 `delete-comments` skill。
