const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const PAGE_SIZE = 200;
let sqlPromise;

function getSql() {
  if (!sqlPromise) {
    const distDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
    sqlPromise = initSqlJs({ locateFile: (file) => path.join(distDir, file) });
  }
  return sqlPromise;
}

const quoteId = (name) => '"' + String(name).replace(/"/g, '""') + '"';

// postMessage 不適合直接傳 BLOB，改成標記物件
function toPlain(value) {
  if (value instanceof Uint8Array) return { __blob: value.length };
  return value;
}

class SqliteDocument {
  constructor(uri, db) {
    this.uri = uri;
    this.db = db;
    this._onDidDispose = new vscode.EventEmitter();
    this.onDidDispose = this._onDidDispose.event;
  }

  static async create(uri, backupId) {
    const SQL = await getSql();
    const source = backupId ? vscode.Uri.parse(backupId) : uri;
    let data;
    try {
      data = await vscode.workspace.fs.readFile(source);
    } catch {
      data = new Uint8Array();
    }
    return new SqliteDocument(uri, new SQL.Database(data.length ? data : undefined));
  }

  async reload() {
    const SQL = await getSql();
    const data = await vscode.workspace.fs.readFile(this.uri);
    this.db.close();
    this.db = new SQL.Database(data);
  }

  async saveTo(target) {
    await vscode.workspace.fs.writeFile(target, this.db.export());
  }

  listTables() {
    const res = this.db.exec(
      "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name"
    );
    if (!res.length) return [];
    return res[0].values.map(([name, type]) => ({ name, type, editable: type === 'table' && this.hasRowid(name) }));
  }

  hasRowid(table) {
    try {
      this.db.exec(`SELECT rowid FROM ${quoteId(table)} LIMIT 0`);
      return true;
    } catch {
      return false;
    }
  }

  loadTable(table, offset) {
    const editable = this.hasRowid(table);
    const total = this.db.exec(`SELECT COUNT(*) FROM ${quoteId(table)}`)[0].values[0][0];
    const select = editable ? `SELECT rowid AS __rowid__, * FROM ${quoteId(table)}` : `SELECT * FROM ${quoteId(table)}`;
    const stmt = this.db.prepare(`${select} LIMIT ? OFFSET ?`, [PAGE_SIZE, offset]);
    let columns = stmt.getColumnNames();
    const rows = [];
    const rowids = [];
    while (stmt.step()) {
      const row = stmt.get().map(toPlain);
      if (editable) rowids.push(row.shift());
      rows.push(row);
    }
    stmt.free();
    if (editable) columns = columns.slice(1);
    return { table, columns, rows, rowids, total, offset, pageSize: PAGE_SIZE, editable };
  }

  updateCell(table, rowid, column, value) {
    this.db.run(`UPDATE ${quoteId(table)} SET ${quoteId(column)} = ? WHERE rowid = ?`, [value, rowid]);
  }

  insertRow(table) {
    this.db.run(`INSERT INTO ${quoteId(table)} DEFAULT VALUES`);
  }

  deleteRow(table, rowid) {
    this.db.run(`DELETE FROM ${quoteId(table)} WHERE rowid = ?`, [rowid]);
  }

  runSql(sql) {
    const results = this.db.exec(sql);
    const last = results[results.length - 1];
    return {
      columns: last ? last.columns : [],
      rows: last ? last.values.map((r) => r.map(toPlain)) : [],
      changes: this.db.getRowsModified(),
    };
  }

  dispose() {
    this.db.close();
    this._onDidDispose.fire();
    this._onDidDispose.dispose();
  }
}

class SqliteEditorProvider {
  constructor(context) {
    this.context = context;
    this.webviews = new Map(); // document -> Set<webviewPanel>
    this._onDidChangeCustomDocument = new vscode.EventEmitter();
    this.onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;
  }

  async openCustomDocument(uri, openContext) {
    const doc = await SqliteDocument.create(uri, openContext.backupId);
    this.webviews.set(doc, new Set());
    doc.onDidDispose(() => this.webviews.delete(doc));
    return doc;
  }

  resolveCustomEditor(document, panel) {
    const panels = this.webviews.get(document);
    panels.add(panel);
    panel.onDidDispose(() => panels.delete(panel));

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    panel.webview.html = this.getHtml(panel.webview);
    panel.webview.onDidReceiveMessage((msg) => this.handleMessage(document, panel, msg));
  }

  markDirty(document) {
    this._onDidChangeCustomDocument.fire({ document });
    // 讓同一份文件開在其他分頁的編輯器也重新整理
    this.refreshAll(document);
  }

  handleMessage(document, panel, msg) {
    const post = (m) => panel.webview.postMessage(m);
    try {
      switch (msg.type) {
        case 'ready':
        case 'listTables':
          post({ type: 'tables', tables: document.listTables() });
          break;
        case 'loadTable':
          post({ type: 'tableData', ...document.loadTable(msg.table, msg.offset || 0) });
          break;
        case 'updateCell':
          document.updateCell(msg.table, msg.rowid, msg.column, msg.value);
          this.markDirty(document);
          break;
        case 'insertRow':
          document.insertRow(msg.table);
          this.markDirty(document);
          break;
        case 'deleteRow':
          document.deleteRow(msg.table, msg.rowid);
          this.markDirty(document);
          break;
        case 'runSql': {
          const result = document.runSql(msg.sql);
          post({ type: 'sqlResult', ...result });
          if (!/^\s*(select|pragma|explain)\b/i.test(msg.sql)) this.markDirty(document);
          break;
        }
      }
    } catch (err) {
      post({ type: 'error', message: String(err && err.message ? err.message : err), source: msg.type });
    }
  }

  refreshAll(document) {
    for (const p of this.webviews.get(document) || []) p.webview.postMessage({ type: 'refresh' });
  }

  async saveCustomDocument(document) {
    await document.saveTo(document.uri);
  }

  async saveCustomDocumentAs(document, destination) {
    await document.saveTo(destination);
  }

  async revertCustomDocument(document) {
    await document.reload();
    this.refreshAll(document);
  }

  async backupCustomDocument(document, context) {
    await document.saveTo(context.destination);
    return {
      id: context.destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(context.destination);
        } catch {
          // 備份檔已不存在就忽略
        }
      },
    };
  }

  getHtml(webview) {
    const media = (f) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('main.css')}">
</head>
<body>
  <aside id="sidebar">
    <div class="side-title">資料表</div>
    <ul id="tables"></ul>
  </aside>
  <div id="sideSplitter" class="splitter v" title="拖曳調整寬度"></div>
  <main>
    <div id="toolbar">
      <button id="toggleSidebar" class="toggle" title="顯示／隱藏資料表列表">☰</button>
      <span id="tableName">（選擇左側資料表）</span>
      <span class="spacer"></span>
      <button id="wrap" class="toggle" title="長文字自動換行">換行</button>
      <button id="toggleSql" class="toggle" title="顯示／隱藏 SQL 面板">SQL</button>
      <button id="addRow" disabled>＋ 新增列</button>
      <button id="prev" disabled>‹</button>
      <span id="pageInfo"></span>
      <button id="next" disabled>›</button>
    </div>
    <div id="grid" class="grid-wrap"></div>
    <div id="sqlSplitter" class="splitter h" title="拖曳調整高度"></div>
    <section id="sqlPanel">
      <div class="sql-head">
        <span>SQL</span>
        <span class="hint">Ctrl/Cmd + Enter 執行</span>
        <span class="spacer"></span>
        <button id="runSql">執行</button>
      </div>
      <textarea id="sql" spellcheck="false" placeholder="SELECT * FROM ..."></textarea>
      <div id="sqlStatus"></div>
      <div id="sqlResult" class="grid-wrap"></div>
    </section>
  </main>
  <script nonce="${nonce}" src="${media('main.js')}"></script>
</body>
</html>`;
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('sqliteLite.editor', new SqliteEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
