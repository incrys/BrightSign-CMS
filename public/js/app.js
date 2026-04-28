'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let players        = {};
let presets        = {};
let currentPlayer  = null;   // id
let playerStatuses = {};
let allFiles       = [];     // file disponibili sul player
let selection      = [];     // file selezionati per il preset corrente
let editingPreset  = null;   // id preset in modifica, o null

// ── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
  await Promise.all([loadPlayers(), loadPresets()]);
  bindEvents();
}

// ── API ───────────────────────────────────────────────────────────────────────
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  if (r.status === 401) { window.location.href = '/login'; throw new Error('Non autenticato'); }
  if (!r.ok) { const e = await r.json().catch(() => ({ error: `HTTP ${r.status}` })); throw new Error(e.error || `HTTP ${r.status}`); }
  return r.json();
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Players ───────────────────────────────────────────────────────────────────
async function loadPlayers() {
  players = await api('GET', '/api/players');
  renderPlayerList();
  Object.keys(players).forEach(id => pingPlayer(id));
}

function renderPlayerList() {
  const el = document.getElementById('player-list');
  el.innerHTML = Object.values(players).map(p => {
    const s = playerStatuses[p.id] || {};
    const cls = s.online === true ? 'on' : s.online === false ? 'off' : '';
    return `<div class="player-item${p.id === currentPlayer ? ' active' : ''}" data-id="${p.id}">
      <span class="p-dot ${cls}"></span>
      <div><div class="p-name">${p.name}</div><div class="p-sub">${p.ip}</div></div>
    </div>`;
  }).join('');
  el.querySelectorAll('.player-item').forEach(el => el.addEventListener('click', () => selectPlayer(el.dataset.id)));
}

async function pingPlayer(id) {
  try {
    playerStatuses[id] = await api('GET', `/api/players/${id}/status`);
  } catch { playerStatuses[id] = { online: false }; }
  renderPlayerList();
  if (id === currentPlayer) updateHeader();
}

async function selectPlayer(id) {
  currentPlayer = id;
  editingPreset = null;
  selection = [];
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('workspace').style.display = 'flex';
  document.getElementById('preset-sidebar-section').style.display = 'none';
  renderPlayerList();
  updateHeader();
  await Promise.all([loadFiles(), loadSdRoot(), loadAutorunStatus()]);
  renderPresetList();
  renderSelectionPanel();

  // Auto-refresh Root SD ogni 10s
  if (window._sdRootTimer) clearInterval(window._sdRootTimer);
  window._sdRootTimer = setInterval(() => {
    if (currentPlayer === id) loadSdRoot();
    else clearInterval(window._sdRootTimer);
  }, 10000);
}

function updateHeader() {
  const p = players[currentPlayer];
  const s = playerStatuses[currentPlayer] || {};
  const dot = document.getElementById('ws-dot');
  dot.className = 'ws-dot ' + (s.online === true ? 'on' : s.online === false ? 'off' : '');
  document.getElementById('ws-name').textContent   = p.name;
  document.getElementById('ws-model').textContent  = s.model  || '?';
  document.getElementById('ws-fw').textContent     = s.fw     ? `BOS ${s.fw}` : '?';
  document.getElementById('ws-serial').textContent = s.serial || '';
  document.getElementById('ws-uptime').textContent = s.uptime || '';
}

// ── Autorun status ────────────────────────────────────────────────────────────
async function loadAutorunStatus() {
  try {
    const r = await api('GET', `/api/players/${currentPlayer}/autorun-status`);
    const pill = document.getElementById('autorun-pill');
    const btn  = document.getElementById('btn-toggle-autorun');
    btn.style.display = '';
    if (r.autorun) {
      pill.className = 'autorun-pill bac';
      pill.querySelector('#autorun-label').textContent = '● BAC autorun';
      btn.className = 'ws-btn ws-btn-danger';
      btn.textContent = '⏸ Disabilita autorun';
      btn.onclick = toggleAutorun.bind(null, 'disable');
    } else if (r.autorunOld) {
      pill.className = 'autorun-pill cms';
      pill.querySelector('#autorun-label').textContent = '● Modalità CMS';
      btn.className = 'ws-btn ws-btn-success';
      btn.textContent = '↩ Ripristina BAC';
      btn.onclick = toggleAutorun.bind(null, 'restore');
    } else {
      pill.className = 'autorun-pill';
      pill.querySelector('#autorun-label').textContent = '○ nessun autorun';
      btn.style.display = 'none';
    }
  } catch(e) { console.error(e); }
}

async function toggleAutorun(action) {
  const btn = document.getElementById('btn-toggle-autorun');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
  try {
    const endpoint = action === 'disable' ? 'disable-autorun' : 'restore-autorun';
    await api('POST', `/api/players/${currentPlayer}/${endpoint}`);
    toast(action === 'disable' ? 'autorun disabilitato, reboot in corso...' : 'autorun ripristinato, reboot in corso...', 'success');
    setTimeout(() => { loadAutorunStatus(); loadSdRoot(); }, 6000);
  } catch(e) { toast(`Errore: ${e.message}`, 'error'); }
  finally { btn.disabled = false; }
}

// ── Files ─────────────────────────────────────────────────────────────────────
let bacPlaylist = null;  // { name, files, otherFiles }

async function loadFiles() {
  document.getElementById('file-sections').innerHTML = '<p class="muted">Caricamento...</p>';
  try {
    const [rMedia, rRoot, rBac] = await Promise.all([
      api('GET', `/api/players/${currentPlayer}/media`),
      api('GET', `/api/players/${currentPlayer}/sd-root`),
      api('GET', `/api/players/${currentPlayer}/bac-playlist`).catch(() => ({ playlist: null }))
    ]);
    const mediaFiles = (rMedia.files || []);
    const rootFiles  = (rRoot.files  || []).map(f => ({ name: f.name, size: f.stat?.size || 0, source: 'sd', path: f.name }));
    const rootNames  = new Set(rootFiles.map(f => f.name));
    allFiles   = [...rootFiles, ...mediaFiles.filter(f => !rootNames.has(f.name))];
    bacPlaylist = rBac.playlist || null;
    renderFileGrid();
  } catch(e) {
    document.getElementById('file-sections').innerHTML = `<p class="muted">Errore: ${e.message}</p>`;
  }
}

function renderFileGrid() {
  const el = document.getElementById('file-sections');
  const cms = allFiles.filter(f => f.source === 'cms');
  const bac = allFiles.filter(f => f.source === 'bac');
  const sd  = allFiles.filter(f => f.source === 'sd');

  let html = '';
  if (sd.length)  html += `<div class="file-group-label">📺 Nella root SD (in riproduzione)</div><div class="file-grid">${sd.map(f => fileCard(f, true)).join('')}</div>`;
  if (cms.length) html += `<div class="file-group-label">📁 Caricati in sd/media/</div><div class="file-grid">${cms.map(f => fileCard(f, false)).join('')}</div>`;

  // Sezione BAC con playlist
  if (bacPlaylist) {
    html += `<div class="file-group-label">📦 Pool BrightAuthor Connect <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--text2)">(sola lettura)</span></div>`;
    html += `<div class="bac-playlist-box">`;
    html += `<div class="bac-playlist-name">▶ ${bacPlaylist.name}</div>`;
    if (bacPlaylist.items?.length) {
      html += `<div class="bac-playlist-items">`;
      let counter = 0;
      for (const item of bacPlaylist.items) {
        if (item.type === 'mediaList') {
          html += `<div class="bac-playlist-item bac-item-header"><span class="bac-item-icon">📋</span><span>${item.name}</span></div>`;
          for (const f of (item.files || [])) {
            counter++;
            html += `<div class="bac-playlist-item bac-item-sub"><span class="bac-item-num">${counter}</span>${iconFor(f.name)} <span>${f.name}</span></div>`;
          }
        } else if (item.type === 'video' || item.type === 'image' || item.type === 'audio') {
          counter++;
          html += `<div class="bac-playlist-item"><span class="bac-item-num">${counter}</span>${iconFor(item.file||item.name)} <span>${item.file || item.name}</span></div>`;
        } else if (item.type === 'html5') {
          const urlPart = item.url ? `<a href="${item.url}" target="_blank" class="bac-html-url">${item.url}</a>` : (item.site || '');
          html += `<div class="bac-playlist-item bac-item-special"><span class="bac-item-icon">🌐</span><span>${item.name}</span><span class="bac-item-detail">${urlPart}</span></div>`;
        } else if (item.type === 'liveVideo') {
          html += `<div class="bac-playlist-item bac-item-special"><span class="bac-item-icon">📡</span><span>${item.name}</span><span class="bac-item-detail">Live Video In</span></div>`;
        } else {
          html += `<div class="bac-playlist-item bac-item-special"><span class="bac-item-icon">⚙️</span><span>${item.name}</span><span class="bac-item-detail">${item.type}</span></div>`;
        }
      }
      html += `</div>`;
    }
    if (bacPlaylist.otherFiles?.length) {
      html += `<div class="bac-other-label">Altri file nel pool</div>`;
      html += `<div class="file-grid" style="padding:6px 8px">${bacPlaylist.otherFiles.map(f => ({...f, source:'bac'})).map(fileCardReadonly).join('')}</div>`;
    }
    html += `</div>`;

    // Sezione comandi UDP
    if (bacPlaylist.transitions?.length) {
      html += `<div class="file-group-label" style="margin-top:10px">📡 Comandi UDP</div>`;
      html += `<div class="udp-table">`;
      html += `<div class="udp-header"><span>Trigger (ricevi)</span><span>Da stato</span><span>A stato</span><span>Invia</span><span></span></div>`;
      for (const t of bacPlaylist.transitions) {
        const outMsg = t.udpOut.join(', ');
        html += `<div class="udp-row">
          <span class="udp-trigger">${t.trigger || '—'}</span>
          <span class="udp-state">${t.from}</span>
          <span class="udp-arrow">→ ${t.to}</span>
          <span class="udp-out">${outMsg || '—'}</span>
          <button class="udp-send-btn ws-btn ws-btn-ghost" data-msg="${t.trigger}" title="Invia UDP: ${t.trigger}">▶ Invia</button>
        </div>`;
      }
      html += `</div>`;
      // Input manuale
      html += `<div class="udp-manual">
        <input type="text" id="udp-manual-input" placeholder="Messaggio UDP personalizzato..." style="flex:1">
        <button class="ws-btn ws-btn-primary" id="udp-manual-send">Invia</button>
      </div>`;
    }
  } else if (bac.length) {
    html += `<div class="file-group-label">📦 Pool BrightAuthor Connect <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--text2)">(sola lettura)</span></div><div class="file-grid">${bac.map(fileCardReadonly).join('')}</div>`;
  }

  if (!sd.length && !cms.length && !bac.length && !bacPlaylist) {
    html = '<p class="muted">Nessun file trovato. Carica qualcosa con il pulsante in alto.</p>';
  }
  el.innerHTML = html;
  el.querySelectorAll('.file-card:not(.file-card-readonly)').forEach(card => {
    card.addEventListener('click', (e) => {
      copyToSd(card.dataset.name);
    });
  });
  el.querySelectorAll('.udp-send-btn').forEach(btn => {
    btn.addEventListener('click', () => sendUdp(btn.dataset.msg));
  });
  const manualSend = document.getElementById('udp-manual-send');
  if (manualSend) {
    manualSend.addEventListener('click', () => {
      const msg = document.getElementById('udp-manual-input').value.trim();
      if (msg) sendUdp(msg);
    });
    document.getElementById('udp-manual-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') { const msg = e.target.value.trim(); if (msg) sendUdp(msg); }
    });
  }
}

async function sendUdp(message) {
  try {
    const r = await api('POST', `/api/players/${currentPlayer}/send-udp`, { message });
    toast(`UDP inviato: "${message}"`, r.ok ? 'success' : 'error');
  } catch(e) { toast(`Errore UDP: ${e.message}`, 'error'); }
}

function fileCard(f, alreadyOnSd) {
  const check = alreadyOnSd ? '<div class="fc-check" style="display:flex">✓</div>' : '';
  const style = alreadyOnSd ? ' style="opacity:.5;cursor:default"' : '';
  const cls   = alreadyOnSd ? ' file-card-readonly' : '';
  return `<div class="file-card${cls}" data-name="${f.name}"${style}>
    ${check}
    <div class="fc-icon">${iconFor(f.name)}</div>
    <div class="fc-name">${f.name}</div>
    <div class="fc-size">${fmtSize(f.size)}</div>
  </div>`;
}

async function copyToSd(name) {
  const f = allFiles.find(f => f.name === name);
  if (!f) return;
  const card = document.querySelector(`.file-card[data-name="${name}"]`);
  if (card) { card.style.opacity = '.5'; card.style.pointerEvents = 'none'; }

  try {
    // Crea preset temporaneo con questo file e applica
    const p = await api('POST', '/api/presets', { name: '_tmp_', files: [f] });
    const r = await api('POST', `/api/players/${currentPlayer}/apply-preset`, { presetId: p.id });
    await api('DELETE', `/api/presets/${p.id}`);
    if (r.results?.[0]?.ok) {
      toast(`${name} copiato nella root SD ✓`, 'success');
    } else {
      toast(`Errore copia ${name}: ${r.results?.[0]?.error || '?'}`, 'error');
    }
    await loadSdRoot();
    await loadFiles();
  } catch(e) {
    toast(`Errore: ${e.message}`, 'error');
    if (card) { card.style.opacity = ''; card.style.pointerEvents = ''; }
  }
}

function fileCard(f) {
  const sel = selection.some(s => s.name === f.name);
  const bac = f.source === 'bac' ? '<span class="fc-bac">BAC</span>' : '';
  return `<div class="file-card${sel ? ' selected' : ''}" data-name="${f.name}">
    ${bac}
    <div class="fc-check">✓</div>
    <div class="fc-icon">${iconFor(f.name)}</div>
    <div class="fc-name">${f.name}</div>
    <div class="fc-size">${fmtSize(f.size)}</div>
  </div>`;
}

function fileCardReadonly(f) {
  return `<div class="file-card file-card-readonly" title="File BAC - non selezionabile">
    <span class="fc-bac">BAC</span>
    <div class="fc-icon" style="opacity:.5">${iconFor(f.name)}</div>
    <div class="fc-name" style="opacity:.5">${f.name}</div>
    <div class="fc-size">${fmtSize(f.size)}</div>
  </div>`;
}

function toggleFile(name) {
  const idx = selection.findIndex(s => s.name === name);
  if (idx >= 0) {
    selection.splice(idx, 1);
  } else {
    const f = allFiles.find(f => f.name === name) || { name, source: 'cms' };
    selection.push(f);
  }
  renderFileGrid();
  renderSelectionPanel();
}

// ── Root SD ───────────────────────────────────────────────────────────────────
async function loadSdRoot() {
  const el = document.getElementById('sd-root-list');
  try {
    const r = await api('GET', `/api/players/${currentPlayer}/sd-root`);
    const files = r.files || [];

    // Aggiorna badge storage nell'header
    const sBadge = document.getElementById('ws-storage');
    if (sBadge && r.storage) {
      const free  = fmtSize(r.storage.free);
      const total = fmtSize(r.storage.total);
      sBadge.textContent = `💾 ${free} liberi / ${total}`;
    }

    if (!files.length) {
      el.innerHTML = '<span class="muted small">Nessun file media nella root SD</span>';
      return;
    }
    el.innerHTML = files.map(f => `
      <div class="root-chip" data-name="${f.name}">
        ${iconFor(f.name)} <span>${f.name}</span>
        <button class="root-del" data-name="${f.name}" title="Rimuovi dall'SD">🗑</button>
      </div>
    `).join('');
    el.querySelectorAll('.root-del').forEach(btn => {
      btn.addEventListener('click', () => deleteFromSd(btn.dataset.name));
    });
  } catch(e) {
    el.innerHTML = `<span class="muted small">Errore: ${e.message}</span>`;
  }
}

async function deleteFromSd(name) {
  if (!confirm(`Rimuovere "${name}" dalla root SD?`)) return;
  try {
    await api('DELETE', `/api/players/${currentPlayer}/sd-file?name=${encodeURIComponent(name)}`);
    toast(`${name} rimosso`, 'info');
    loadSdRoot();
    loadFiles();
  } catch(e) { toast(`Errore: ${e.message}`, 'error'); }
}

// ── Selection / Preset editor ─────────────────────────────────────────────────
function renderSelectionPanel() {
  const el = document.getElementById('selection-list');
  if (!el) return;
  if (!selection.length) {
    el.innerHTML = '<p class="muted small">Clicca i file a sinistra per aggiungerli al preset.</p>';
    return;
  }
  el.innerHTML = selection.map((f, i) => `
    <div class="sel-item">
      <span class="si-icon">${iconFor(f.name)}</span>
      <span class="si-name">${f.name}</span>
      ${f.source === 'bac' ? '<span class="si-bac">BAC</span>' : ''}
      <button class="si-rm" data-i="${i}">✕</button>
    </div>
  `).join('');
  el.querySelectorAll('.si-rm').forEach(btn => {
    btn.addEventListener('click', () => {
      selection.splice(parseInt(btn.dataset.i), 1);
      renderFileGrid();
      renderSelectionPanel();
    });
  });
}

// ── Presets ───────────────────────────────────────────────────────────────────
async function loadPresets() {
  presets = await api('GET', '/api/presets');
  renderPresetList();
}

function renderPresetList() {
  const el = document.getElementById('preset-list');
  const entries = Object.values(presets);
  if (!entries.length) {
    el.innerHTML = '<p class="muted small" style="padding:4px 8px">Nessun preset</p>';
    return;
  }
  el.innerHTML = entries.map(p => `
    <div class="preset-item${editingPreset === p.id ? ' active' : ''}" data-id="${p.id}">
      <span class="preset-icon">📋</span>
      <span class="preset-name">${p.name}</span>
      <button class="preset-del" data-id="${p.id}" title="Elimina">✕</button>
    </div>
  `).join('');
  el.querySelectorAll('.preset-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('preset-del')) return;
      loadPresetIntoEditor(el.dataset.id);
    });
  });
  el.querySelectorAll('.preset-del').forEach(btn => {
    btn.addEventListener('click', () => deletePreset(btn.dataset.id));
  });
}

function loadPresetIntoEditor(id) {
  const p = presets[id];
  if (!p) return;
  editingPreset = id;
  selection = [...p.files];
  document.getElementById('preset-name-input').value = p.name;
  document.getElementById('preset-editor-title').textContent = `Modifica: ${p.name}`;
  renderPresetList();
  renderFileGrid();
  renderSelectionPanel();
}

async function savePreset() {
  const name = document.getElementById('preset-name-input').value.trim();
  if (!name) { toast('Inserisci un nome per il preset', 'error'); return; }
  if (!selection.length) { toast('Seleziona almeno un file', 'error'); return; }

  const btn = document.getElementById('btn-save-preset');
  btn.disabled = true;

  try {
    if (editingPreset) {
      // Elimina vecchio e ricrea (API semplice)
      await api('DELETE', `/api/presets/${editingPreset}`);
    }
    const p = await api('POST', '/api/presets', { name, files: selection });
    editingPreset = p.id;
    presets = await api('GET', '/api/presets');
    renderPresetList();
    toast(`Preset "${name}" salvato`, 'success');
  } catch(e) { toast(`Errore: ${e.message}`, 'error'); }
  finally { btn.disabled = false; }
}

async function deletePreset(id) {
  await api('DELETE', `/api/presets/${id}`);
  if (editingPreset === id) {
    editingPreset = null;
    selection = [];
    document.getElementById('preset-name-input').value = '';
    document.getElementById('preset-editor-title').textContent = 'Nuovo preset';
    renderFileGrid();
    renderSelectionPanel();
  }
  presets = await api('GET', '/api/presets');
  renderPresetList();
  toast('Preset eliminato', 'info');
}

async function applyNow() {
  if (!selection.length) { toast('Nessun file selezionato', 'error'); return; }
  if (!currentPlayer) { toast('Nessun player selezionato', 'error'); return; }

  const btn = document.getElementById('btn-apply-now');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Copia in corso...';

  try {
    // Crea preset temporaneo e applica
    const p = await api('POST', '/api/presets', { name: '_tmp_' + Date.now(), files: selection });
    const r = await api('POST', `/api/players/${currentPlayer}/apply-preset`, { presetId: p.id });
    // Cancella preset temporaneo
    await api('DELETE', `/api/presets/${p.id}`);

    const ok   = r.results.filter(x => x.ok).length;
    const fail = r.results.filter(x => !x.ok);
    if (fail.length) {
      toast(`${ok} file copiati, ${fail.length} falliti: ${fail.map(x=>x.name).join(', ')}`, 'error');
    } else {
      toast(`${ok} file copiati nella root SD ✓`, 'success');
    }
    loadSdRoot();
    loadFiles();
  } catch(e) { toast(`Errore: ${e.message}`, 'error'); }
  finally { btn.disabled = false; btn.textContent = '▶ Copia nella root SD'; }
}

// ── Upload ────────────────────────────────────────────────────────────────────
async function uploadFiles(files) {
  // Controlla spazio libero sulla SD del player prima di iniziare
  try {
    const rStorage = await api('GET', `/api/players/${currentPlayer}/sd-root`);
    const freeBytes = rStorage.storage?.free || 0;
    if (freeBytes > 0) {
      const totalSize = files.reduce((acc, f) => acc + f.size, 0);
      if (totalSize > freeBytes) {
        const freeMB = (freeBytes / 1048576).toFixed(1);
        const needMB = (totalSize / 1048576).toFixed(1);
        toast(`Spazio insufficiente sulla SD: servono ${needMB} MB, disponibili ${freeMB} MB`, 'error');
        return;
      }
    }
  } catch {
    toast('Impossibile verificare lo spazio disponibile: player non raggiungibile', 'error');
    return;
  }

  for (const file of files) {
    const id  = 'up_' + Date.now();
    const row = document.createElement('div');
    row.className = 'upload-item'; row.id = id;
    row.innerHTML = `<span>${file.name}</span><div class="upload-bar-bg"><div class="upload-bar" style="width:0" id="b${id}"></div></div>`;
    document.getElementById('upload-progress').appendChild(row);

    const fd = new FormData();
    fd.append('file', file, file.name);

    await new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      const TIMEOUT_MS = 120000; // 2 minuti

      const timer = setTimeout(() => {
        xhr.abort();
        const bar = document.getElementById('b' + id);
        if (bar) bar.style.background = 'var(--red)';
        toast(`Timeout upload "${file.name}": connessione troppo lenta o spazio insufficiente`, 'error');
        setTimeout(() => row.remove(), 4000);
        resolve();
      }, TIMEOUT_MS);

      xhr.open('POST', `/api/players/${currentPlayer}/upload-sd`);

      xhr.upload.onprogress = e => {
        if (e.lengthComputable)
          document.getElementById('b' + id).style.width = (e.loaded / e.total * 100) + '%';
      };

      xhr.onload = () => {
        clearTimeout(timer);
        const bar = document.getElementById('b' + id);
        if (xhr.status < 300) {
          if (bar) bar.style.background = 'var(--accent)';
          toast(`${file.name} caricato ✓`, 'success');
        } else {
          if (bar) bar.style.background = 'var(--red)';
          let errMsg = `Errore upload "${file.name}"`;
          try { const resp = JSON.parse(xhr.responseText); if (resp.error) errMsg = resp.error; } catch {}
          toast(errMsg, 'error');
        }
        setTimeout(() => row.remove(), 3000);
        resolve();
      };

      xhr.onerror = () => {
        clearTimeout(timer);
        toast(`Errore di rete: "${file.name}"`, 'error');
        setTimeout(() => row.remove(), 3000);
        resolve();
      };

      xhr.onabort = () => { clearTimeout(timer); resolve(); };
      xhr.send(fd);
    });
  }
  await loadSdRoot();
  await loadFiles();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function iconFor(name) {
  const ext = name.split('.').pop().toLowerCase();
  return ['mp4','mov','avi','mkv','mpg','mpeg','webm'].includes(ext) ? '🎬' :
         ['jpg','jpeg','png','gif','bmp','webp','svg'].includes(ext) ? '🖼' : '📄';
}
function fmtSize(b) {
  if (!b) return '';
  if (b < 1024) return b + 'B';
  if (b < 1048576) return (b/1024).toFixed(0) + 'KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + 'MB';
  return (b/1073741824).toFixed(2) + 'GB';
}

// ── Events ────────────────────────────────────────────────────────────────────
function bindEvents() {
  // Add player
  document.getElementById('btn-add-player').onclick = () => document.getElementById('modal-player').classList.add('open');
  document.getElementById('btn-cancel-player').onclick = () => document.getElementById('modal-player').classList.remove('open');
  document.getElementById('modal-player').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('open'); });
  document.getElementById('btn-confirm-player').onclick = async () => {
    const name = document.getElementById('np-name').value.trim();
    const ip   = document.getElementById('np-ip').value.trim();
    const pass = document.getElementById('np-pass').value.trim();
    if (!name || !ip || !pass) { toast('Compila tutti i campi', 'error'); return; }
    try {
      const p = await api('POST', '/api/players', { name, ip, password: pass });
      players[p.id] = p;
      document.getElementById('modal-player').classList.remove('open');
      ['np-name','np-ip','np-pass'].forEach(id => document.getElementById(id).value = '');
      renderPlayerList();
      pingPlayer(p.id);
      toast(`Player "${name}" aggiunto`, 'success');
    } catch(e) { toast(`Errore: ${e.message}`, 'error'); }
  };

  // Delete player
  document.getElementById('btn-delete-player').onclick = async () => {
    if (!currentPlayer) return;
    const p = players[currentPlayer];
    if (!confirm(`Rimuovere "${p.name}"?`)) return;
    await api('DELETE', `/api/players/${currentPlayer}`);
    delete players[currentPlayer];
    currentPlayer = null;
    document.getElementById('empty-state').style.display = '';
    document.getElementById('workspace').style.display = 'none';
    renderPlayerList();
    toast('Player rimosso', 'info');
  };

  // Reboot
  document.getElementById('btn-reboot').onclick = async () => {
    try { await api('POST', `/api/players/${currentPlayer}/reboot`); toast('Reboot inviato', 'info'); }
    catch(e) { toast(`Errore: ${e.message}`, 'error'); }
  };

  // Reload files
  document.getElementById('btn-reload-files').onclick = loadFiles;
  document.getElementById('btn-reload-root').onclick = loadSdRoot;

  // Reboot CMS
  document.getElementById('btn-reboot-cms').onclick = async () => {
    try { await api('POST', `/api/players/${currentPlayer}/reboot`); toast('Reboot inviato', 'info'); }
    catch(e) { toast(`Errore: ${e.message}`, 'error'); }
  };



  // Upload
  document.getElementById('file-input').onchange = e => {
    if (e.target.files.length) uploadFiles([...e.target.files]);
    e.target.value = '';
  };
}

init();
