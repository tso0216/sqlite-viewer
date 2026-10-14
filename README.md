# SQLite Lite Editor

在 VS Code 直接開啟 `.sqlite` / `.sqlite3` / `.db` / `.db3` 檔案，檢視與編輯內容。使用 [sql.js](https://github.com/sql-js/sql.js)（WebAssembly），不需要安裝原生模組。

## 功能
- 左側列出所有資料表與檢視（view），點選即可瀏覽，每頁 200 列
- 雙擊儲存格會開啟浮動的多行編輯框，長文字也能完整顯示；Enter 確認、Shift+Enter 換行、Esc 取消；輸入 `NULL` 會存成 NULL
- 拖曳欄位標題右緣調整欄寬，雙擊右緣自動符合內容；工具列「換行」讓長文字自動換行顯示
- 左側資料表列表、下方 SQL 面板都可拖曳分隔線調整大小，或用工具列 ☰ / SQL 按鈕隱藏
- 新增列（使用預設值）、刪除列
- 下方 SQL 面板可執行任意 SQL（Ctrl/Cmd + Enter）
- 修改後分頁會標示未儲存，用 Cmd/Ctrl + S 寫回檔案；「還原檔案」會捨棄修改

## 限制
- 整個資料庫會載入記憶體，不適合非常大的檔案
- WITHOUT ROWID 資料表與 view 為唯讀（可用 SQL 面板修改）
- BLOB 欄位只顯示大小，不能直接編輯
- 沒有逐步 undo；要放棄修改請用「還原檔案」
