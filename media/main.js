(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const state = Object.assign(
    {
      table: null,
      offset: 0,
      sql: '',
      sidebarWidth: 200,
      sqlHeight: 260,
      sidebarHidden: false,
      sqlHidden: false,
      wrap: false,
      colWidths: {}, // 'table:<name>' -> 欄寬陣列
    },
    vscode.getState()
  );
  let current = null; // 最近一次載入的 tableData
  let activeEditor = null; // 編輯中儲存格的 finish 函式

  const save = () => {
    state.sql = $('sql').value;
    vscode.setState(state);
  };

  function cellText(v) {
    if (v === null || v === undefined) return { text: 'NULL', cls: 'null' };
    if (typeof v === 'object' && '__blob' in v) return { text: `<BLOB ${v.__blob} bytes>`, cls: 'blob' };
    return { text: String(v), cls: typeof v === 'number' ? 'num' : '' };
  }

  // ---------- 面板配置 ----------

  function applyLayout() {
    $('sidebar').style.width = state.sidebarWidth + 'px';
    $('sqlPanel').style.height = state.sqlHeight + 'px';
    $('sidebar').hidden = $('sideSplitter').hidden = state.sidebarHidden;
    $('sqlPanel').hidden = $('sqlSplitter').hidden = state.sqlHidden;
    $('toggleSidebar').classList.toggle('on', !state.sidebarHidden);
    $('toggleSql').classList.toggle('on', !state.sqlHidden);
    $('wrap').classList.toggle('on', state.wrap);
    document.body.classList.toggle('wrap', state.wrap);
  }

  function makeDraggable(handle, onMove, onEnd) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add('resizing');
      const move = (ev) => onMove(ev, e);
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        document.body.classList.remove('resizing');
        onEnd && onEnd();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  makeDraggable(
    $('sideSplitter'),
    (ev) => {
      state.sidebarWidth = clamp(ev.clientX, 100, window.innerWidth - 200);
      $('sidebar').style.width = state.sidebarWidth + 'px';
    },
    save
  );

  makeDraggable(
    $('sqlSplitter'),
    (ev) => {
      const mainRect = document.querySelector('main').getBoundingClientRect();
      state.sqlHeight = clamp(mainRect.bottom - ev.clientY, 80, mainRect.height - 120);
      $('sqlPanel').style.height = state.sqlHeight + 'px';
    },
    save
  );

  $('toggleSidebar').onclick = () => {
    state.sidebarHidden = !state.sidebarHidden;
    applyLayout();
    save();
  };
  $('toggleSql').onclick = () => {
    state.sqlHidden = !state.sqlHidden;
    applyLayout();
    save();
  };
  $('wrap').onclick = () => {
    state.wrap = !state.wrap;
    applyLayout();
    save();
  };

  // ---------- 表格 ----------

  function renderGrid(container, columns, rows, opts = {}) {
    container.innerHTML = '';
    if (!columns.length) {
      container.innerHTML = '<div class="empty">沒有資料</div>';
      return;
    }
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    if (opts.rowids) head.appendChild(document.createElement('th')).className = 'act';
    for (const c of columns) {
      const th = document.createElement('th');
      th.textContent = c;
      th.title = c;
      head.appendChild(th);
    }

    const body = table.createTBody();
    rows.forEach((row, r) => {
      const tr = body.insertRow();
      if (opts.rowids) {
        const td = tr.insertCell();
        td.className = 'act';
        const del = document.createElement('button');
        del.className = 'del';
        del.title = '刪除這一列';
        del.textContent = '✕';
        del.onclick = () => vscode.postMessage({ type: 'deleteRow', table: state.table, rowid: opts.rowids[r] });
        td.appendChild(del);
      }
      row.forEach((v, c) => {
        const td = tr.insertCell();
        const { text, cls } = cellText(v);
        td.textContent = text;
        td.title = text;
        if (cls) td.className = cls;
        if (opts.rowids && !(v && typeof v === 'object')) {
          td.ondblclick = () => editCell(td, v, opts.rowids[r], columns[c]);
        }
      });
    });
    container.appendChild(table);
    setupColumns(table, opts.widthKey);
  }

  // 先用自動排版量出欄寬，再改成固定欄寬，讓使用者可以拖曳欄位邊界調整
  function setupColumns(table, widthKey) {
    const ths = [...table.tHead.rows[0].cells];
    const saved = widthKey && state.colWidths[widthKey];
    const widths = ths.map((th, i) => {
      if (th.classList.contains('act')) return 28;
      if (saved && saved.length === ths.length) return saved[i];
      return Math.ceil(th.getBoundingClientRect().width) || 150;
    });

    const colgroup = document.createElement('colgroup');
    const cols = widths.map((w) => {
      const col = document.createElement('col');
      col.style.width = w + 'px';
      colgroup.appendChild(col);
      return col;
    });
    table.insertBefore(colgroup, table.firstChild);
    table.classList.add('fixed');
    const updateTableWidth = () => (table.style.width = widths.reduce((a, b) => a + b, 0) + 'px');
    updateTableWidth();

    const persist = () => {
      if (!widthKey) return;
      state.colWidths[widthKey] = widths.slice();
      save();
    };

    ths.forEach((th, i) => {
      if (th.classList.contains('act')) return;
      const handle = document.createElement('div');
      handle.className = 'col-resizer';
      handle.title = '拖曳調整欄寬，雙擊自動符合內容';
      th.appendChild(handle);

      let startWidth = 0;
      handle.addEventListener('pointerdown', () => (startWidth = widths[i]), true);
      makeDraggable(
        handle,
        (ev, start) => {
          widths[i] = Math.max(40, startWidth + ev.clientX - start.clientX);
          cols[i].style.width = widths[i] + 'px';
          updateTableWidth();
        },
        persist
      );
      handle.ondblclick = (e) => {
        e.stopPropagation();
        widths[i] = fitWidth(table, i);
        cols[i].style.width = widths[i] + 'px';
        updateTableWidth();
        persist();
      };
    });
  }

  const measureCtx = document.createElement('canvas').getContext('2d');
  function fitWidth(table, colIndex) {
    const cells = [table.tHead.rows[0].cells[colIndex], ...[...table.tBodies[0].rows].map((r) => r.cells[colIndex])];
    let max = 0;
    for (const cell of cells) {
      if (!cell) continue;
      measureCtx.font = getComputedStyle(cell).font;
      for (const line of cell.textContent.split('\n')) max = Math.max(max, measureCtx.measureText(line).width);
    }
    return clamp(Math.ceil(max) + 24, 40, 1000);
  }

  // 用浮動的多行輸入框編輯，長文字也能完整看到
  function editCell(td, value, rowid, column) {
    if (activeEditor) activeEditor(true);
    const original = value === null ? 'NULL' : String(value);
    const rect = td.getBoundingClientRect();
    const ta = document.createElement('textarea');
    ta.className = 'cell-editor';
    ta.value = original;
    ta.spellcheck = false;
    const width = Math.min(Math.max(rect.width, 320), window.innerWidth - 16);
    ta.style.width = width + 'px';
    ta.style.left = clamp(rect.left, 8, window.innerWidth - width - 8) + 'px';
    ta.style.top = rect.top + 'px';
    document.body.appendChild(ta);
    td.classList.add('editing');

    const autosize = () => {
      ta.style.height = 'auto';
      const maxH = window.innerHeight - rect.top - 8;
      ta.style.height = Math.min(ta.scrollHeight + 2, Math.max(maxH, 60)) + 'px';
    };
    autosize();
    ta.oninput = autosize;
    ta.focus();
    ta.select();

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      activeEditor = null;
      ta.remove();
      td.classList.remove('editing');
      if (commit && ta.value !== original) {
        const newValue = ta.value === 'NULL' ? null : ta.value;
        vscode.postMessage({ type: 'updateCell', table: state.table, rowid, column, value: newValue });
      }
    };
    activeEditor = finish;
    ta.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        finish(false);
      }
    };
    ta.onblur = () => finish(true);
  }

  $('grid').addEventListener('scroll', () => activeEditor && activeEditor(true));
  window.addEventListener('resize', () => activeEditor && activeEditor(true));

  function renderTables(tables) {
    const ul = $('tables');
    ul.innerHTML = '';
    if (state.table && !tables.some((t) => t.name === state.table)) {
      state.table = null;
      current = null;
      renderTable(null);
    }
    for (const t of tables) {
      const li = document.createElement('li');
      li.textContent = t.name;
      li.title = t.name;
      if (t.type === 'view') li.classList.add('view');
      if (t.name === state.table) li.classList.add('active');
      li.onclick = () => selectTable(t.name, 0);
      ul.appendChild(li);
    }
    if (!tables.length) ul.innerHTML = '<li class="muted">（沒有資料表）</li>';
  }

  function selectTable(name, offset) {
    state.table = name;
    state.offset = offset;
    save();
    for (const li of $('tables').children) li.classList.toggle('active', li.textContent === name);
    vscode.postMessage({ type: 'loadTable', table: name, offset });
  }

  function renderTable(data) {
    if (!data) {
      $('tableName').textContent = '（選擇左側資料表）';
      $('grid').innerHTML = '';
      $('pageInfo').textContent = '';
      $('addRow').disabled = $('prev').disabled = $('next').disabled = true;
      return;
    }
    $('tableName').textContent = data.table + (data.editable ? '' : '（唯讀）');
    const end = Math.min(data.offset + data.rows.length, data.total);
    $('pageInfo').textContent = data.total ? `${data.offset + 1}–${end} / ${data.total}` : '0 列';
    $('addRow').disabled = !data.editable;
    $('prev').disabled = data.offset <= 0;
    $('next').disabled = end >= data.total;
    renderGrid($('grid'), data.columns, data.rows, {
      rowids: data.editable ? data.rowids : null,
      widthKey: 'table:' + data.table,
    });
  }

  function runSql() {
    const sql = $('sql').value.trim();
    if (!sql) return;
    save();
    $('sqlStatus').textContent = '執行中…';
    $('sqlStatus').className = '';
    vscode.postMessage({ type: 'runSql', sql });
  }

  $('addRow').onclick = () => vscode.postMessage({ type: 'insertRow', table: state.table });
  $('prev').onclick = () => selectTable(state.table, Math.max(0, state.offset - current.pageSize));
  $('next').onclick = () => selectTable(state.table, state.offset + current.pageSize);
  $('runSql').onclick = runSql;
  $('sql').value = state.sql || '';
  $('sql').onkeydown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      runSql();
    }
  };

  window.addEventListener('message', ({ data: msg }) => {
    switch (msg.type) {
      case 'tables':
        renderTables(msg.tables);
        break;
      case 'tableData':
        if (msg.table !== state.table) return;
        current = msg;
        // 刪到最後一頁沒資料時往前退一頁
        if (!msg.rows.length && msg.offset > 0) return selectTable(msg.table, Math.max(0, msg.offset - msg.pageSize));
        renderTable(msg);
        break;
      case 'sqlResult':
        $('sqlStatus').textContent = msg.columns.length ? `${msg.rows.length} 列` : `完成，影響 ${msg.changes} 列`;
        renderGrid($('sqlResult'), msg.columns, msg.rows);
        break;
      case 'refresh':
        vscode.postMessage({ type: 'listTables' });
        if (state.table) vscode.postMessage({ type: 'loadTable', table: state.table, offset: state.offset });
        break;
      case 'error':
        if (msg.source === 'runSql') {
          $('sqlStatus').textContent = '錯誤：' + msg.message;
          $('sqlStatus').className = 'err';
        } else {
          showToast(msg.message);
          if (current) renderTable(current);
        }
        break;
    }
  });

  function showToast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = '錯誤：' + text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  applyLayout();
  vscode.postMessage({ type: 'ready' });
  if (state.table) selectTable(state.table, state.offset);
})();
