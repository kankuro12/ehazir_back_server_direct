const express = require('express');
const session = require('express-session');
const { WebSocketServer } = require('ws');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ehazir1234';
const WEB_PORT = process.env.WEB_PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'ehazir-web-secret';

function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function mask(v) {
    if (!v) return '';
    return v.length <= 4 ? '****' : v.slice(0, 2) + '****' + v.slice(-2);
}

const CSS = `*{box-sizing:border-box}body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0f1420;color:#e8ecf4;margin:0;padding:24px}h1{font-size:20px;margin:0 0 16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:16px}.card{background:#1a2233;border:1px solid #2a3550;border-radius:10px;padding:16px}.card .k{font-size:12px;color:#8b96b0;text-transform:uppercase;letter-spacing:.06em}.card .v{font-size:24px;font-weight:700;margin-top:4px}.rfid{font-family:ui-monospace,Consolas,monospace;font-size:clamp(18px,4vw,34px);font-weight:700;word-break:break-all;background:#0b101c;border:1px solid #2a3550;border-radius:10px;padding:18px;margin-bottom:16px}.pill{display:inline-block;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:600}.ok{background:#123f2a;color:#5eeaa0}.warn{background:#4a3413;color:#ffcf7a}.live{font-size:12px;color:#5eeaa0}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px;border-bottom:1px solid #2a3550}th{color:#8b96b0;font-weight:600}td.mono{font-family:ui-monospace,Consolas,monospace}nav{margin-bottom:16px}a{color:#7aa5ff;margin-right:12px}form.card{max-width:560px}label{display:block;margin:8px 0}input{width:100%;padding:8px;border-radius:6px;border:1px solid #2a3550;background:#0b101c;color:#e8ecf4}button{background:#2f6bff;color:#fff;border:0;border-radius:6px;padding:9px 16px;cursor:pointer;font-weight:600}`;

const DASH = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ehazir device</title><style>${CSS}</style></head><body>
<h1>ehazir device <span class="live" id="live">● connecting…</span></h1>
<nav><a href="/">dashboard</a><a href="/setup">setup</a><a href="/logout">logout</a></nav>
<div class="rfid" id="rfid">—</div>
<div class="grid">
<div class="card"><div class="k">Sync state</div><div class="v" id="sync">—</div></div>
<div class="card"><div class="k">Unsynced rows</div><div class="v" id="unsynced">—</div></div>
<div class="card"><div class="k">Queue / Cache</div><div class="v" id="queue">—</div></div>
<div class="card"><div class="k">Uptime</div><div class="v" id="uptime">—</div></div>
</div>
<div class="card"><div class="k">Recent taps</div><table><thead><tr><th>time</th><th>date</th><th>rfid</th><th>synced</th></tr></thead><tbody id="rows"></tbody></table></div>
<script>
(function(){
  var el = function(id){return document.getElementById(id)};
  var wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  function fmtUptime(s){var h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h+'h '+m+'m'}
  function render(m){
    if (m.latest) el('rfid').textContent = m.latest.rfid + '  ·  ' + m.latest.date + ' ' + m.latest.time;
    el('sync').innerHTML = m.syncing ? '<span class="pill warn">syncing</span>' : '<span class="pill ok">idle</span>';
    el('unsynced').textContent = m.unsynced;
    el('queue').textContent = m.pending + ' / ' + m.cacheSize;
    el('uptime').textContent = fmtUptime(m.uptimeSec);
    el('rows').innerHTML = m.recent.map(function(r){
      return '<tr><td>'+r.time+'</td><td>'+r.date+'</td><td class="mono">'+r.rfid+'</td><td>'+(r.isSynced?'yes':'no')+'</td></tr>';
    }).join('');
  }
  function connect(){
    var ws = new WebSocket(wsProto + '//' + location.host + '/live');
    ws.onopen = function(){ el('live').textContent = '● live'; };
    ws.onmessage = function(ev){ render(JSON.parse(ev.data)); };
    ws.onclose = function(){ el('live').textContent = '● reconnecting…'; setTimeout(connect, 2000); };
  }
  connect();
})();
</script></body></html>`;

function loginPage(msg) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>login</title><style>${CSS}</style></head><body>
<h1>ehazir device</h1><form class="card" method="post" action="/login">
${msg ? `<p style="color:#ff9a9a">${esc(msg)}</p>` : ''}
<label>password<input type="password" name="password" autofocus></label>
<button type="submit">login</button></form></body></html>`;
}

function startWeb(state) {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 12 * 3600 * 1000 } }));
    app.use((req, res, next) => {
        res.set('Access-Control-Allow-Origin', '*');
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        next();
    });

    // Public: LAN poller reads e.data, no session cookie available cross-origin.
    app.get('/latest', (req, res) => {
        state.db.get(`SELECT rfid FROM attendance ORDER BY id DESC LIMIT 1`, [], (err, row) => {
            if (err) return res.status(500).json({ data: null, error: err.message });
            res.json({ data: row ? row.rfid : null });
        });
    });

    const requireAuth = (req, res, next) => {
        if (req.session && req.session.auth) return next();
        if (req.path === '/login') return next();
        if (req.accepts('json') && !req.accepts('html')) return res.status(401).json({ error: 'login required' });
        return res.redirect('/login');
    };

    app.get('/login', (req, res) => res.send(loginPage('')));
    app.post('/login', (req, res) => {
        if (req.body.password === ADMIN_PASSWORD) {
            req.session.auth = true;
            return res.redirect('/');
        }
        res.status(401).send(loginPage('wrong password'));
    });
    app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

    app.use(requireAuth);
    app.get('/', (req, res) => res.send(DASH));

    function statusJson(cb) {
        const s = state.getSync();
        state.db.get(`SELECT COUNT(*) c FROM attendance WHERE isSynced = 0`, [], (err, unsynced) => {
            state.db.get(`SELECT id, date, time, rfid FROM attendance ORDER BY id DESC LIMIT 1`, [], (err2, latest) => {
                state.db.all(`SELECT date, time, rfid, isSynced FROM attendance ORDER BY id DESC LIMIT 20`, [], (err3, recent) => {
                    cb({
                        uptimeSec: Math.floor(process.uptime()),
                        cacheSize: state.attendanceCache.size,
                        pending: state.pendingRows.length,
                        syncing: s.syncing,
                        lastData: s.lastData,
                        unsynced: err ? null : unsynced.c,
                        latest: err2 ? null : (latest || null),
                        recent: err3 ? [] : recent,
                        timezone: s.timezone,
                        serverPort: s.serverPort,
                        serverHosts: s.serverHosts,
                        deviceUpdateTime: s.deviceUpdateTime,
                        mainDomain: s.mainDomain,
                        localToken: mask(s.localToken),
                        deviceId: mask(s.deviceId),
                    });
                });
            });
        });
    }

    app.get('/status', (req, res) => statusJson((j) => res.json(j)));

    const fs = require('fs');
    const path = require('path');
    const ENV_PATH = path.join(__dirname, '.env');
    const ENV_EXAMPLE = path.join(__dirname, '.env.example');

    function readEnvFile(p) {
        const out = {};
        if (!fs.existsSync(p)) return out;
        fs.readFileSync(p, 'utf-8').split('\n').forEach(line => {
            const t = line.trim();
            if (!t || t.startsWith('#') || !t.includes('=')) return;
            const i = t.indexOf('=');
            out[t.slice(0, i)] = t.slice(i + 1);
        });
        return out;
    }

    app.get('/setup', (req, res) => {
        const example = readEnvFile(ENV_EXAMPLE);
        const current = readEnvFile(ENV_PATH);
        const keys = Object.keys(example).length ? Object.keys(example) : Object.keys(current);
        const secret = (k) => /TOKEN|PASSWORD|SECRET/.test(k);
        const inputs = keys.map(k => {
            const v = current[k] != null ? current[k] : example[k];
            return `<label>${esc(k)}<input name="${esc(k)}" type="${secret(k) ? 'password' : 'text'}" value="${esc(secret(k) ? '' : v)}" placeholder="${secret(k) ? 'leave blank to keep' : ''}"></label>`;
        }).join('');
        res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>setup</title><style>${CSS}</style></head><body>
<h1>setup</h1><nav><a href="/">dashboard</a><a href="/setup">setup</a><a href="/logout">logout</a></nav>
<form class="card" method="post" action="/setup">${inputs}<label>register token (optional)<input name="_register_token"></label><br><button type="submit">save</button></form></body></html>`);
    });

    app.post('/setup', async (req, res) => {
        const body = req.body || {};
        const registerToken = (body._register_token || '').trim();
        delete body._register_token;
        const prev = readEnvFile(ENV_PATH);
        Object.keys(body).forEach(k => { if (body[k] === '' && prev[k] != null) body[k] = prev[k]; });
        const lines = Object.entries(body).map(([k, v]) => `${k}=${v}`);
        fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf-8');
        Object.assign(process.env, body);
        if (!registerToken) return res.redirect('/');
        try {
            const { generateRandomString } = require('./helper');
            const local_token = generateRandomString(32);
            const deviceId = generateRandomString(16);
            await require('axios').post(`${process.env.MAIN_PROTOCOL}://${process.env.MAIN_DOMAIN}/api/device/register`, {
                token: registerToken, local_token, device_id: deviceId
            });
            let content = fs.readFileSync(ENV_PATH, 'utf8');
            content = content.includes('LOCAL_TOKEN=') ? content.replace(/LOCAL_TOKEN=.*/g, `LOCAL_TOKEN=${local_token}`) : content + `\nLOCAL_TOKEN=${local_token}`;
            content = content.includes('DEVICE_ID=') ? content.replace(/DEVICE_ID=.*/g, `DEVICE_ID=${deviceId}`) : content + `\nDEVICE_ID=${deviceId}`;
            fs.writeFileSync(ENV_PATH, content, 'utf8');
            res.send('saved + registered. restart process to apply.');
        } catch (e) {
            res.status(500).send('saved, register failed: ' + esc(e.response ? JSON.stringify(e.response.data) : e.message));
        }
    });

    const server = app.listen(WEB_PORT, () => console.log(`Web panel on port ${WEB_PORT}`));

    // Live feed: poll DB each second, push snapshot only when latest row or counts change.
    const wss = new WebSocketServer({ server, path: '/live' });
    let lastSeen = { id: -1, unsynced: -1, pending: -1, syncing: null };
    const timer = setInterval(() => {
        if (wss.clients.size === 0) return;
        statusJson((snap) => {
            const cur = { id: snap.latest ? snap.latest.id : -1, unsynced: snap.unsynced, pending: snap.pending, syncing: snap.syncing };
            if (cur.id === lastSeen.id && cur.unsynced === lastSeen.unsynced && cur.pending === lastSeen.pending && cur.syncing === lastSeen.syncing) return;
            lastSeen = cur;
            const msg = JSON.stringify(snap);
            wss.clients.forEach((c) => { if (c.readyState === 1) c.send(msg); });
        });
    }, 1000);
    wss.on('connection', (ws) => statusJson((snap) => {
        if (snap.latest) lastSeen.id = snap.latest.id;
        ws.send(JSON.stringify(snap));
    }));
    server.on('close', () => clearInterval(timer));

    return server;
}

module.exports = { startWeb };
