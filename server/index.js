/**
 * BrightSign CMS v5 - Server
 * HTTP nativo Node.js - zero dipendenze per le chiamate DWS
 */
'use strict';

const express    = require('express');
const dgram      = require('dgram');
const fileUpload = require('express-fileupload');
const fs         = require('fs');
const path       = require('path');
const http       = require('http');
const crypto     = require('crypto');
const { generatePlaylistJson, generateAutorun } = require('./cms-autorun');
const cookieParser = require('cookie-parser');
const { authenticate, authMiddleware, createSession, deleteSession } = require('./auth');

const app  = express();
const PORT = process.env.PORT || 4000;       // if want change 4000 with other port
const PLAYERS_FILE = path.join(__dirname, 'players.json');

app.use(express.json());
app.use(cookieParser());
app.use(fileUpload({ limits: { fileSize: 500 * 1024 * 1024 } }));
app.use(authMiddleware);
app.use(express.static(path.join(__dirname, '../public')));

// ── Players DB ────────────────────────────────────────────────────────────────
function loadPlayers() {
  if (!fs.existsSync(PLAYERS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8')); } catch { return {}; }
}
function savePlayers(p) { fs.writeFileSync(PLAYERS_FILE, JSON.stringify(p, null, 2)); }

// ── Digest Auth HTTP ──────────────────────────────────────────────────────────
function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

function parseWwwAuth(header) {
  const get = (k) => { const m = header.match(new RegExp(`${k}="([^"]+)"`)); return m ? m[1] : ''; };
  return { realm: get('realm'), nonce: get('nonce'), qop: get('qop'), opaque: get('opaque') };
}

function buildDigestAuth(method, urlPath, user, pass, wwwAuth) {
  const { realm, nonce, qop, opaque } = wwwAuth;
  const ha1  = md5(`${user}:${realm}:${pass}`);
  const ha2  = md5(`${method}:${urlPath}`);
  const nc   = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const resp = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);
  let auth = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${urlPath}", response="${resp}"`;
  if (qop)    auth += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) auth += `, opaque="${opaque}"`;
  return auth;
}

/**
 * Richiesta HTTP con Digest Auth verso la DWS
 * Supporta body Buffer (per upload file binari)
 */
function dwsRequest(ip, password, method, urlPath, body, contentType) {
  return new Promise((resolve, reject) => {
    const user = 'admin';
    const bodyBuf = body instanceof Buffer ? body
                  : (body !== undefined && body !== null) ? Buffer.from(body) : null;
    // Encode spazi e caratteri speciali nel path (escludi ? e = e & per query string)
    const safePath = urlPath.replace(/ /g, '%20');

    function doRequest(authHeader) {
      const headers = {};
      if (authHeader) headers['Authorization'] = authHeader;
      if (bodyBuf) {
        headers['Content-Type']   = contentType || 'application/octet-stream';
        headers['Content-Length'] = bodyBuf.length;
      }

      const req = http.request({ host: ip, port: 80, method, path: safePath, headers }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const resBody = Buffer.concat(chunks).toString('utf8');

          if (res.statusCode === 401 && !authHeader) {
            // Prima richiesta senza auth → ottieni il nonce e riprova
            const wwwAuth = parseWwwAuth(res.headers['www-authenticate'] || '');
            const auth = buildDigestAuth(method, urlPath, user, password, wwwAuth);
            doRequest(auth);
          } else {
            resolve({ status: res.statusCode, body: resBody });
          }
        });
      });

      req.on('error', reject);
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    }

    doRequest(null);
  });
}

const dwsGet = (ip, pw, p)             => dwsRequest(ip, pw, 'GET',    p);
const dwsPut = (ip, pw, p, b, ct)      => dwsRequest(ip, pw, 'PUT',    p, b, ct);
const dwsDel = (ip, pw, p)             => dwsRequest(ip, pw, 'DELETE', p);

/**
 * Upload file via multipart/form-data verso la DWS BrightSign
 * Regola: PUT su /api/v1/files/sd/CARTELLA/ con solo il nome file nel filename
 * Es: urlPath=/api/v1/files/sd/media/video.mp4 → PUT su /api/v1/files/sd/media/ + filename=video.mp4
 * Es: urlPath=/api/v1/files/sd/autorun.brs    → PUT su /api/v1/files/sd/       + filename=autorun.brs
 */
function dwsUpload(ip, password, urlPath, bodyBuf, _contentType) {
  return new Promise((resolve, reject) => {
    const user = 'admin';

    // Separa cartella e nome file
    const parts    = urlPath.replace(/^\/api\/v1\/files\/sd\/?/, '').split('/');
    const filename = parts.pop();                          // es. video.mp4
    const folder   = parts.length ? parts.join('/') + '/' : '';  // es. media/
    const putPath  = '/api/v1/files/sd/' + folder;        // es. /api/v1/files/sd/media/

    function buildMultipart() {
      const boundary = '----BrightSignCMSBoundary' + Date.now().toString(16);
      const partHead = Buffer.from(
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="filedata"; filename="' + filename + '"\r\n' +
        'Content-Type: application/octet-stream\r\n\r\n'
      );
      const partTail = Buffer.from('\r\n--' + boundary + '--\r\n');
      return {
        body: Buffer.concat([partHead, bodyBuf, partTail]),
        ct:   'multipart/form-data; boundary=' + boundary
      };
    }

    // Step 1: GET su putPath per ottenere il nonce (senza consumarlo)
    const probeReq = http.request({ host: ip, port: 80, method: 'GET', path: putPath }, (probeRes) => {
      const wwwAuth = probeRes.headers['www-authenticate'] || '';
      probeRes.resume();
      probeRes.on('end', () => {
        const auth = buildDigestAuth('PUT', putPath, user, password, parseWwwAuth(wwwAuth));

        // Step 2: PUT multipart con auth
        const real = buildMultipart();
        const realReq = http.request({
          host: ip, port: 80, method: 'PUT', path: putPath,
          headers: {
            'Authorization':  auth,
            'Content-Type':   real.ct,
            'Content-Length': real.body.length,
          }
        }, (realRes) => {
          const chunks = [];
          realRes.on('data', c => chunks.push(c));
          realRes.on('end', () => resolve({ status: realRes.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        realReq.on('error', reject);
        realReq.write(real.body);
        realReq.end();
      });
    });
    probeReq.on('error', reject);
    probeReq.end();
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Legge local-sync.json dal player e restituisce la lista dei file media nel pool BAC
 * [ { name, size, poolPath } ]
 */
async function getBacPoolFiles(ip, password) {
  try {
    // La DWS restituisce il contenuto dei file codificato in base64 con ?contents
    const r = await dwsGet(ip, password, '/api/v1/files/sd/local-sync.json?contents');
    if (r.status !== 200) return [];
    const wrapper = JSON.parse(r.body);
    const b64 = wrapper?.data?.result?.contents;
    if (!b64) return [];
    const sync = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    // Struttura BAC: { files: { download: [ {name, link, size, ...} ] } }
    const downloads = sync?.files?.download || [];
    const mediaExts = /\.(mp4|mov|avi|mpg|mpeg|mkv|jpg|jpeg|png|gif|bmp|webp)$/i;
    return downloads
      .filter(f => mediaExts.test(f.name))
      .map(f => ({
        name:   f.name,
        size:   f.size || 0,
        source: 'bac',
        path:   f.link  // es. "pool/0/f/sha1-..."
      }));
  } catch (e) {
    console.log('[bac] errore:', e.message);
    return [];
  }
}

// ── API: Players ──────────────────────────────────────────────────────────────
// ── Login page ───────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    await authenticate(username, password);
    const token = createSession(username);
    res.cookie('cms_session', token, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge:   8 * 60 * 60 * 1000
    });
    res.json({ ok: true, username });
  } catch(e) {
    console.warn(`[auth] Login fallito per "${username}": ${e.message}`);
    res.status(401).json({ error: e.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.cms_session;
  if (token) deleteSession(token);
  res.clearCookie('cms_session');
  res.json({ ok: true });
});

// ── Players ───────────────────────────────────────────────────────────────────
app.get('/api/players', (req, res) => res.json(loadPlayers()));

app.post('/api/players', (req, res) => {
  const { name, ip, password } = req.body;
  if (!name || !ip || !password) return res.status(400).json({ error: 'name, ip e password richiesti' });
  const players = loadPlayers();
  const id = Date.now().toString();
  players[id] = { id, name, ip, password };
  savePlayers(players);
  res.json(players[id]);
});

app.delete('/api/players/:id', (req, res) => {
  const players = loadPlayers();
  if (!players[req.params.id]) return res.status(404).json({ error: 'not found' });
  delete players[req.params.id];
  savePlayers(players);
  res.json({ ok: true });
});

// ── API: Status ───────────────────────────────────────────────────────────────
app.get('/api/players/:id/status', async (req, res) => {
  const p = loadPlayers()[req.params.id];
  if (!p) return res.status(404).json({ error: 'not found' });
  try {
    const r = await dwsGet(p.ip, p.password, '/api/v1/info');
    if (r.status !== 200) return res.json({ online: false });
    const info = JSON.parse(r.body);
    const d    = info?.data?.result || info;
    res.json({
      online: true,
      model:  d.model                          || '?',
      serial: d.serial                         || '?',
      fw:     d.FWVersion                      || d.version  || '?',
      uptime: d.upTime                         || null,
    });
  } catch { res.json({ online: false }); }
});

// ── API: Media ────────────────────────────────────────────────────────────────

// GET lista file: unione di sd/media/ (file CMS) + pool BAC (da local-sync.json)
app.get('/api/players/:id/media', async (req, res) => {
  const p = loadPlayers()[req.params.id];
  if (!p) return res.status(404).json({ error: 'not found' });

  try {
    // File caricati dal CMS in sd/media/
    const rMedia = await dwsGet(p.ip, p.password, '/api/v1/files/sd/media');
    let cmsFiles = [];
    if (rMedia.status === 200) {
      const data = JSON.parse(rMedia.body);
      // DWS: { data: { result: { files: [{name, type, stat}] } } }
      const raw  = data?.data?.result?.files || data?.result?.files || data.files || data;
      const arr  = Array.isArray(raw) ? raw : [];
      cmsFiles   = arr
        .filter(f => f.type === 'file' && /\.(mp4|mov|avi|mpg|mpeg|mkv|jpg|jpeg|png|gif|bmp|webp)$/i.test(f.name || f))
        .map(f => ({
          name:   f.name,
          size:   f.stat?.size || 0,
          source: 'cms',
          path:   `media/${f.name}`
        }));
    }

    // File nel pool BAC (da local-sync.json)
    const bacFiles = await getBacPoolFiles(p.ip, p.password);

    // Unisci: i file CMS hanno priorità su quelli BAC con lo stesso nome
    const cmsNames = new Set(cmsFiles.map(f => f.name));
    const merged   = [
      ...cmsFiles,
      ...bacFiles.filter(f => !cmsNames.has(f.name))
    ];

    res.json({ files: merged });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

// POST upload file in sd/media/
app.post('/api/players/:id/upload-media', async (req, res) => {
  const p = loadPlayers()[req.params.id];
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!req.files?.file) return res.status(400).json({ error: 'file mancante' });

  const file = req.files.file;
  console.log(`[upload] ${file.name} (${file.size} bytes)`);

  try {
    // Assicura che la cartella media/ esista (crea un file .keep se non c'è)
    const mediaCheck = await dwsGet(p.ip, p.password, '/api/v1/files/sd/media');
    if (mediaCheck.status === 404) {
      await dwsUpload(p.ip, p.password, '/api/v1/files/sd/media/.keep', Buffer.from(''), 'text/plain');
    }

    // Carica il file
    const r = await dwsUpload(p.ip, p.password, `/api/v1/files/sd/media/${file.name}`, file.data, 'application/octet-stream');
    console.log(`[upload] file status=${r.status} body=${r.body.slice(0,120)}`);

    if (r.status >= 400) return res.status(r.status).json({ error: `DWS: HTTP ${r.status} — ${r.body}` });
    res.json({ ok: true, name: file.name, size: file.size, source: 'cms' });
  } catch (e) {
    console.error(`[upload] errore:`, e.message);
    res.status(503).json({ error: e.message });
  }
});

// POST upload file direttamente in sd/ (root SD)
app.post('/api/players/:id/upload-sd', async (req, res) => {
  const p = loadPlayers()[req.params.id];
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!req.files?.file) return res.status(400).json({ error: 'file mancante' });
  const file = req.files.file;
  console.log(`[upload-sd] ${file.name} (${file.size} bytes) → sd/`);
  try {
    const r = await dwsUpload(p.ip, p.password, `/api/v1/files/sd/${file.name}`, file.data, 'application/octet-stream');
    console.log(`[upload-sd] status=${r.status} ${r.body.slice(0,100)}`);
    if (r.status >= 400) return res.status(r.status).json({ error: r.body });
    res.json({ ok: true, name: file.name, size: file.size, source: 'sd' });
  } catch(e) {
    res.status(503).json({ error: e.message });
  }
});

// DELETE file da sd/media/
app.delete('/api/players/:id/media/:filename', async (req, res) => {
  const p = loadPlayers()[req.params.id];
  if (!p) return res.status(404).json({ error: 'not found' });
  try {
    const r = await dwsDel(p.ip, p.password, `/api/v1/files/sd/media/${req.params.filename}`);
    res.json({ ok: r.status < 400 });
  } catch (e) { res.status(503).json({ error: e.message }); }
});

// ── API: Playlist ─────────────────────────────────────────────────────────────
app.get('/api/players/:id/playlist', async (req, res) => {
  const p = loadPlayers()[req.params.id];
  if (!p) return res.status(404).json({ error: 'not found' });
  try {
    const r = await dwsGet(p.ip, p.password, '/api/v1/files/sd/cms_playlist.json?contents');
    if (r.status === 404) return res.json({ playlist: null });
    if (r.status !== 200) return res.json({ playlist: null });
    const wrapper = JSON.parse(r.body);
    const b64 = wrapper?.data?.result?.contents;
    if (!b64) return res.json({ playlist: null });
    res.json({ playlist: JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) });
  } catch (e) { res.status(503).json({ error: e.message }); }
});

app.post('/api/players/:id/publish', async (req, res) => {
  const p = loadPlayers()[req.params.id];
  if (!p) return res.status(404).json({ error: 'not found' });
  const { name, items, default_image_duration, pushAutorun } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'items[] richiesto' });

  try {
    const json = generatePlaylistJson({ name: name || 'Playlist CMS', items, default_image_duration });
    const rp   = await dwsUpload(p.ip, p.password, '/api/v1/files/sd/cms_playlist.json', Buffer.from(json), 'application/json');
    if (rp.status >= 400) throw new Error(`PUT cms_playlist.json: HTTP ${rp.status}`);
    console.log(`[publish] cms_playlist.json → ${p.ip} OK`);

    if (pushAutorun) {
      const brs = generateAutorun({ name: p.name, ip: p.ip });
      const ra  = await dwsUpload(p.ip, p.password, '/api/v1/files/sd/autorun.brs', Buffer.from(brs), 'text/plain');
      if (ra.status >= 400) throw new Error(`PUT autorun.brs: HTTP ${ra.status}`);
      console.log(`[publish] autorun.brs → ${p.ip} OK`);
      setTimeout(() => dwsPut(p.ip, p.password, '/api/v1/control/reboot', Buffer.from('{}'), 'application/json').catch(() => {}), 2000);
      return res.json({ ok: true, action: 'autorun+reboot' });
    }
    res.json({ ok: true, action: 'playlist-only' });
  } catch (e) {
    console.error('[publish]', e.message);
    res.status(503).json({ error: e.message });
  }
});

app.post('/api/players/:id/deploy-autorun', async (req, res) => {
  const p = loadPlayers()[req.params.id];
  if (!p) return res.status(404).json({ error: 'not found' });
  try {
    const brs = generateAutorun({ name: p.name, ip: p.ip });
    const r   = await dwsUpload(p.ip, p.password, '/api/v1/files/sd/autorun.brs', Buffer.from(brs), 'text/plain');
    if (r.status >= 400) throw new Error(`HTTP ${r.status} — ${r.body}`);
    console.log(`[deploy] autorun.brs → ${p.ip} OK`);
    setTimeout(() => dwsPut(p.ip, p.password, '/api/v1/control/reboot', Buffer.from('{}'), 'application/json').catch(() => {}), 2000);
    res.json({ ok: true, message: 'autorun.brs caricato, reboot in corso...' });
  } catch (e) { res.status(503).json({ error: e.message }); }
});

app.post('/api/players/:id/reboot', async (req, res) => {
  const p = loadPlayers()[req.params.id];
  if (!p) return res.status(404).json({ error: 'not found' });
  try {
    await dwsPut(p.ip, p.password, '/api/v1/control/reboot', Buffer.from('{}'), 'application/json');
    res.json({ ok: true });
  } catch (e) { res.status(503).json({ error: e.message }); }
});

/**
 * Rinomina un file sull'SD: scarica contenuto, ricarica con nuovo nome, cancella originale
 */
async function dwsRename(ip, password, fromPath, toPath) {
  // 1. Scarica contenuto con ?contents (risponde base64)
  const r = await dwsGet(ip, password, `/api/v1/files/sd/${fromPath}?contents`);
  if (r.status !== 200) throw new Error(`Lettura ${fromPath} fallita: HTTP ${r.status}`);
  const wrapper = JSON.parse(r.body);
  const b64 = wrapper?.data?.result?.contents;
  if (!b64) throw new Error(`Contenuto ${fromPath} non trovato`);
  const content = Buffer.from(b64, 'base64');

  // 2. Carica con nuovo nome
  const r2 = await dwsUpload(ip, password, `/api/v1/files/sd/${toPath}`, content, 'application/octet-stream');
  if (r2.status >= 400) throw new Error(`Scrittura ${toPath} fallita: HTTP ${r2.status}`);

  // 3. Cancella originale
  const r3 = await dwsDel(ip, password, `/api/v1/files/sd/${fromPath}`);
  if (r3.status >= 400) throw new Error(`Cancellazione ${fromPath} fallita: HTTP ${r3.status}`);
  return true;
}

// POST disabilita autorun (rinomina autorun.brs → autorun_old.brs) + reboot
app.post('/api/players/:id/disable-autorun', async (req, res) => {
  const p = loadPlayers()[req.params.id];
  if (!p) return res.status(404).json({ error: 'not found' });
  try {
    await dwsRename(p.ip, p.password, 'autorun.brs', 'autorun_old.brs');
    console.log(`[autorun] disabilitato su ${p.ip}`);
    setTimeout(() => dwsPut(p.ip, p.password, '/api/v1/control/reboot', Buffer.from('{}'), 'application/json').catch(() => {}), 2000);
    res.json({ ok: true, message: 'autorun disabilitato, reboot in corso...' });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

// POST ripristina autorun (rinomina autorun_old.brs → autorun.brs) + reboot
app.post('/api/players/:id/restore-autorun', async (req, res) => {
  const p = loadPlayers()[req.params.id];
  if (!p) return res.status(404).json({ error: 'not found' });
  try {
    await dwsRename(p.ip, p.password, 'autorun_old.brs', 'autorun.brs');
    console.log(`[autorun] ripristinato su ${p.ip}`);
    setTimeout(() => dwsPut(p.ip, p.password, '/api/v1/control/reboot', Buffer.from('{}'), 'application/json').catch(() => {}), 2000);
    res.json({ ok: true, message: 'autorun ripristinato, reboot in corso...' });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

// POST copia file dal pool BAC alla root SD
app.post('/api/players/:id/copy-to-sd', async (req, res) => {
  const p = loadPlayers()[req.params.id];
  if (!p) return res.status(404).json({ error: 'not found' });
  const { poolPath, name } = req.body;
  if (!poolPath || !name) return res.status(400).json({ error: 'poolPath e name richiesti' });
  try {
    // Scarica dal pool
    const r = await dwsGet(p.ip, p.password, `/api/v1/files/sd/${poolPath}?contents`);
    if (r.status !== 200) throw new Error(`Lettura pool fallita: HTTP ${r.status}`);
    const b64 = JSON.parse(r.body)?.data?.result?.contents;
    if (!b64) throw new Error('Contenuto non trovato nel pool');
    const content = Buffer.from(b64, 'base64');

    // Carica nella root SD
    const r2 = await dwsUpload(p.ip, p.password, `/api/v1/files/sd/${name}`, content, 'application/octet-stream');
    if (r2.status >= 400) throw new Error(`Scrittura SD fallita: HTTP ${r2.status}`);
    console.log(`[copy] ${poolPath} → sd/${name}`);
    res.json({ ok: true, name });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

// GET stato autorun (esiste autorun.brs? esiste autorun_old.brs?)
app.get('/api/players/:id/autorun-status', async (req, res) => {
  const p = loadPlayers()[req.params.id];
  if (!p) return res.status(404).json({ error: 'not found' });
  try {
    const [r1, r2] = await Promise.all([
      dwsGet(p.ip, p.password, '/api/v1/files/sd/autorun.brs'),
      dwsGet(p.ip, p.password, '/api/v1/files/sd/autorun_old.brs'),
    ]);
    res.json({
      autorun:    r1.status === 200,
      autorunOld: r2.status === 200,
    });
  } catch (e) { res.status(503).json({ error: e.message }); }
});

// GET playlist BAC attiva (legge local-sync.json → autoplay JSON → estrae media)
app.get('/api/players/:id/bac-playlist', async (req, res) => {
  const p = loadPlayers()[req.params.id];
  if (!p) return res.status(404).json({ error: 'not found' });
  try {
    // 1. Leggi local-sync.json
    const r1 = await dwsGet(p.ip, p.password, '/api/v1/files/sd/local-sync.json?contents');
    if (r1.status !== 200) return res.json({ playlist: null });
    const b641 = JSON.parse(r1.body)?.data?.result?.contents;
    if (!b641) return res.json({ playlist: null });
    const sync = JSON.parse(Buffer.from(b641, 'base64').toString('utf8'));
    const downloads = sync?.files?.download || [];

    // 2. Trova autoplay-*.json
    const autoplayEntry = downloads.find(f => f.name.startsWith('autoplay-') && f.name.endsWith('.json'));
    if (!autoplayEntry) return res.json({ playlist: null, message: 'Nessuna playlist BAC trovata' });

    const presentationName = autoplayEntry.name.replace('autoplay-', '').replace('.json', '');

    // 3. Leggi autoplay JSON dal pool
    const r2 = await dwsGet(p.ip, p.password, `/api/v1/files/sd/${autoplayEntry.link}?contents`);
    if (r2.status !== 200) return res.json({ playlist: null });
    const b642 = JSON.parse(r2.body)?.data?.result?.contents;
    if (!b642) return res.json({ playlist: null });
    const autoplay = JSON.parse(Buffer.from(b642, 'base64').toString('utf8'));

    // 3b. Leggi anche il .bml per gli URL degli htmlSites
    const htmlSiteUrls = {};  // { siteName: url }
    const bmlEntry = downloads.find(f => f.name.endsWith('.bml'));
    if (bmlEntry) {
      try {
        const rBml = await dwsGet(p.ip, p.password, `/api/v1/files/sd/${bmlEntry.link}?contents`);
        if (rBml.status === 200) {
          const b64Bml = JSON.parse(rBml.body)?.data?.result?.contents;
          if (b64Bml) {
            const bml = JSON.parse(Buffer.from(b64Bml, 'base64').toString('utf8'));
            const htmlSites = bml?.bsdm?.htmlSites || {};
            // Mappa siteId → url
            const siteIdToUrl = {};
            for (const [id, site] of Object.entries(htmlSites)) {
              const url = site?.url?.params?.find(p => p.value)?.value || '';
              if (url) siteIdToUrl[id] = url;
            }
            // Mappa stateName → url tramite mediaStates
            const mediaStates = bml?.bsdm?.mediaStates?.mediaStatesById || {};
            for (const state of Object.values(mediaStates)) {
              const siteId = state?.contentItem?.siteId;
              if (siteId && siteIdToUrl[siteId]) {
                const stateName = state?.name || '';
                htmlSiteUrls[stateName] = siteIdToUrl[siteId];
              }
            }
          }
        }
      } catch(e) { console.log('[bml] errore lettura:', e.message); }
    }

    // 4. Estrai tutti gli elementi dalla struttura BrightAuthor
    const zones = autoplay?.BrightAuthor?.zones || [];
    const items = [];  // { name, type, subtype, detail }

    function extractState(state) {
      const name = state.name;
      if (state.mediaListItem) {
        // Lista di video/immagini
        const contentItems = state.mediaListItem.contentItems || [];
        if (contentItems.length) {
          items.push({
            name,
            type: 'mediaList',
            files: contentItems.map(ci => ({
              name: ci.fileName || ci.filename || ci.stateName,
              type: ci.type || 'video'
            }))
          });
        }
      } else if (state.videoItem) {
        const fname = state.videoItem.fileName || state.videoItem.filename || name;
        items.push({ name, type: 'video', file: fname });
      } else if (state.imageItem) {
        const fname = state.imageItem.fileName || state.imageItem.filename || name;
        items.push({ name, type: 'image', file: fname });
      } else if (state.html5Item) {
        const siteName = state.html5Item.htmlSiteName || '';
        const siteUrl  = htmlSiteUrls[name] || htmlSiteUrls[siteName] || '';
        items.push({ name, type: 'html5', site: siteName, url: siteUrl });
      } else if (state.liveVideoItem) {
        items.push({ name, type: 'liveVideo' });
      } else if (state.audioItem) {
        const fname = state.audioItem.fileName || name;
        items.push({ name, type: 'audio', file: fname });
      } else {
        // Tipo sconosciuto — mostralo comunque
        const typeKey = Object.keys(state).find(k => k.endsWith('Item'));
        if (typeKey) items.push({ name, type: typeKey.replace('Item','') });
      }
    }

    for (const zone of zones) {
      const states = zone?.playlist?.states || zone?.states || [];
      for (const state of states) extractState(state);
    }

    // 5. Estrai transizioni UDP (deduplicato per trigger+udpOut)
    const transitions = [];
    const seenTransitions = new Set();
    for (const zone of zones) {
      const trans = zone?.playlist?.transitions || [];
      for (const t of trans) {
        const trigger = t?.userEvent?.data?.data || t?.userEvent?.name || '';
        const from    = t?.sourceMediaState || '';
        const to      = t?.targetMediaState || '';
        const udpOut  = [];
        for (const cmd of (t?.commands || [])) {
          for (const udp of (cmd?.sendUDPCommand || [])) {
            const msg = (udp?.message || []).map(m => m.value || '').join('');
            if (msg) udpOut.push(msg);
          }
        }
        // Deduplicazione: chiave = trigger + udpOut (ignora from/to duplicati)
        const key = `${trigger}|${udpOut.join(',')}`;
        if (!seenTransitions.has(key) && (trigger || udpOut.length)) {
          seenTransitions.add(key);
          transitions.push({ trigger, from, to, udpOut });
        }
      }
    }

    // 5b. File media referenziati (per deduplicazione)
    const referencedNames = new Set();
    for (const it of items) {
      if (it.file) referencedNames.add(it.file);
      if (it.files) it.files.forEach(f => referencedNames.add(f.name));
    }

    // 6. File nel pool non referenziati dalla playlist
    const mediaExts = /\.(mp4|mov|avi|mkv|jpg|jpeg|png|gif|bmp|webp)$/i;
    const otherFiles = downloads
      .filter(f => mediaExts.test(f.name) && !referencedNames.has(f.name))
      .map(f => ({ name: f.name, type: 'video', poolPath: f.link }));
    
    // Retrocompatibilità: files = lista flat dei file media
    const files = [];
    for (const it of items) {
      if (it.file && mediaExts.test(it.file)) files.push({ name: it.file, type: it.type });
      if (it.files) it.files.forEach(f => { if (mediaExts.test(f.name)) files.push(f); });
    }

    res.json({
      playlist: {
        name: presentationName,
        items,
        transitions,
        files,
        otherFiles
      }
    });
  } catch(e) {
    console.error('[bac-playlist]', e.message);
    res.status(503).json({ error: e.message });
  }
});

// POST invia comando UDP al player via socket UDP
app.post('/api/players/:id/send-udp', async (req, res) => {
  const p = loadPlayers()[req.params.id];
  if (!p) return res.status(404).json({ error: 'not found' });
  const { message, port } = req.body;
  if (!message) return res.status(400).json({ error: 'message richiesto' });
  const udpPort = port || 5000;  // porta default BrightSign UDP

  try {
    await new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      const buf  = Buffer.from(message);
      sock.send(buf, 0, buf.length, udpPort, p.ip, (err) => {
        sock.close();
        if (err) reject(err); else resolve();
      });
    });
    console.log(`[udp] → ${p.ip}:${udpPort} "${message}"`);
    res.json({ ok: true });
  } catch(e) {
    console.error(`[udp] errore:`, e.message);
    res.status(503).json({ error: e.message });
  }
});

// DELETE file dalla root SD
app.delete('/api/players/:id/sd-file', async (req, res) => {
  const p = loadPlayers()[req.params.id];
  if (!p) return res.status(404).json({ error: 'not found' });
  const filename = req.query.name;
  if (!filename) return res.status(400).json({ error: 'name richiesto' });
  try {
    const r = await dwsDel(p.ip, p.password, `/api/v1/files/sd/${encodeURIComponent(filename)}`);
    console.log(`[delete-sd] "${filename}" status=${r.status}`);
    res.json({ ok: r.status < 400 });
  } catch(e) { res.status(503).json({ error: e.message }); }
});

// GET lista file media nella root SD (esclude cartelle di sistema)
app.get('/api/players/:id/sd-root', async (req, res) => {
  const p = loadPlayers()[req.params.id];
  if (!p) return res.status(404).json({ error: 'not found' });
  try {
    const r = await dwsGet(p.ip, p.password, '/api/v1/files/sd');
    if (r.status !== 200) return res.status(502).json({ error: `HTTP ${r.status}` });
    const data    = JSON.parse(r.body);
    const result  = data?.data?.result || {};
    const files   = result.files || [];
    const storage = result.storageInfo || null;
    const mediaExts = /\.(mp4|mov|avi|mkv|mpg|mpeg|jpg|jpeg|png|gif|bmp|webp)$/i;
    const media = files.filter(f => f.type === 'file' && mediaExts.test(f.name));
    res.json({
      files: media,
      storage: storage ? {
        free:  storage.bytesFree  || 0,
        total: storage.sizeBytes  || storage.size || 0
      } : null
    });
  } catch(e) { res.status(503).json({ error: e.message }); }
});

// ── Presets ──────────────────────────────────────────────────────────────────
const PRESETS_FILE = path.join(__dirname, 'presets.json');
function loadPresets() {
  if (!fs.existsSync(PRESETS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')); } catch { return {}; }
}
function savePresets(p) { fs.writeFileSync(PRESETS_FILE, JSON.stringify(p, null, 2)); }

// GET tutti i preset
app.get('/api/presets', (req, res) => res.json(loadPresets()));

// POST salva preset  { name, files: [{name, source, poolPath?}] }
app.post('/api/presets', (req, res) => {
  const { name, files } = req.body;
  if (!name || !files) return res.status(400).json({ error: 'name e files richiesti' });
  const presets = loadPresets();
  const id = Date.now().toString();
  presets[id] = { id, name, files, created: new Date().toISOString() };
  savePresets(presets);
  res.json(presets[id]);
});

// DELETE preset
app.delete('/api/presets/:id', (req, res) => {
  const presets = loadPresets();
  delete presets[req.params.id];
  savePresets(presets);
  res.json({ ok: true });
});

// POST applica preset al player: copia i file nella root SD
app.post('/api/players/:id/apply-preset', async (req, res) => {
  const p = loadPlayers()[req.params.id];
  if (!p) return res.status(404).json({ error: 'not found' });
  const { presetId } = req.body;
  const preset = loadPresets()[presetId];
  if (!preset) return res.status(404).json({ error: 'preset non trovato' });

  const results = [];
  for (const file of preset.files) {
    try {
      // Sorgente: pool BAC, sd/media/, o root SD
      const srcPath = file.source === 'bac' ? file.poolPath
                    : file.source === 'sd'  ? file.name
                    : `media/${file.name}`;
      // Scarica contenuto
      const r = await dwsGet(p.ip, p.password, `/api/v1/files/sd/${srcPath}?contents`);
      if (r.status !== 200) { results.push({ name: file.name, ok: false, error: `HTTP ${r.status}` }); continue; }
      const b64 = JSON.parse(r.body)?.data?.result?.contents;
      if (!b64) { results.push({ name: file.name, ok: false, error: 'contenuto vuoto' }); continue; }
      const content = Buffer.from(b64, 'base64');
      // Carica nella root SD
      const r2 = await dwsUpload(p.ip, p.password, `/api/v1/files/sd/${file.name}`, content, 'application/octet-stream');
      results.push({ name: file.name, ok: r2.status < 400 });
      console.log(`[preset] ${file.name} → sd/ status=${r2.status}`);
    } catch(e) {
      results.push({ name: file.name, ok: false, error: e.message });
    }
  }
  res.json({ ok: true, results });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`BrightSign CMS v5 in ascolto su http://localhost:${PORT}`);
});
