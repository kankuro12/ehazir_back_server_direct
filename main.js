require('dotenv').config();

const net = require('net');
const sqlite3 = require('sqlite3').verbose();
   
const path = require('path');
const https = require('https');
const fs = require('fs');
const { default: axios } = require('axios');


const SERVER_PORT = process.env.SERVER_PORT || 5000;
const SERVER_HOSTS = (process.env.SERVER_HOST || 'localhost').split(',');


const MAIN_DOMAIN = process.env.MAIN_DOMAIN || 'localhost:8000';
const MAIN_PROTOCOL = process.env.MAIN_PROTOCOL || 'http';
const LOCAL_TOKEN = process.env.LOCAL_TOKEN || 'your_local_token';
const DEVICE_ID = process.env.DEVICE_ID || 'your_device_id';
const DEVICE_UPDATE_TIME = process.env.DEVICE_UPDATE_TIME || 30; // in seconds
const TIMEZONE = process.env.TIMEZONE || 'Asia/Kathmandu';
try { new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }); }
catch (e) { console.error('Invalid TIMEZONE:', TIMEZONE); process.exit(1); }
 
const debugMode = true;


// Open (or create) the database.
const db = new sqlite3.Database('./attendance2.db', (err) => {
    if (err) {
        console.error('Could not open database:', err);
        process.exit(1);
    }
});

var lastData = '';
var syncing = false;
var syncTimeOut;

// Configure SQLite for better write concurrency.
db.run('PRAGMA journal_mode = WAL;');

// Use serialize to ensure sequential execution. Fresh DB each deploy, no migration.
db.serialize(() => {
    db.run(`
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      rfid TEXT NOT NULL CHECK (length(rfid) = 24),
      isSynced INTEGER DEFAULT 0
    )
  `, (err) => {
        if (err) {
            console.error('Table creation error:', err);
            process.exit(1);
        }
        insertStmt = db.prepare(INSERT_SQL);

        // Start the TCP server only after the table is created.
        startServer();
    });
});

// In-memory debounce cache: Map<rfid, lastAcceptedMs>. Pending inserts queue below.
const attendanceCache = new Map();
const pendingRows = [];

//load attendance cahche from the database
function loadAttendanceCache() {
    return new Promise((resolve, reject) => {
        const sql = `SELECT rfid FROM attendance WHERE date = ? GROUP BY rfid`;
        const today = getCurrentDataTime().currentDate;

        db.all(sql, [today], (err, rows) => {
            if (err) {
                console.error('Error loading attendance cache:', err);
                reject(err);
            } else {
                console.log('Attendance cache loaded successfully.');
                rows.forEach(row => {
                    attendanceCache.set(row.rfid, Date.now());
                });
                resolve();
            }
        });
    });
}

// Batch flush interval (in milliseconds)
const BATCH_INTERVAL_MS = 1000;

// Prepared after table exists (createAttendanceTable). Null until then.
let insertStmt = null;
const INSERT_SQL = `
  INSERT INTO attendance (date, time, rfid)
  VALUES (?, ?, ?)
`;

// Function to flush queued records to the database in a transaction.
function flushCache(done) {
    if (pendingRows.length === 0) { if (done) done(); return; }

    let size=0;
    const batch = pendingRows.splice(0, pendingRows.length);
    if (!insertStmt) { pendingRows.unshift(...batch); if (done) setImmediate(done); return; }

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        batch.forEach((row) => {
            insertStmt.run(row.date, row.time, row.rfid, (err) => {
                if (err) console.error(`Insert error for ${row.rfid}:`, err);
            });
            size++;
        });
        db.run('COMMIT', () => {
            if(!shuttingDown && !syncing){
                if(syncTimeOut){
                    clearTimeout(syncTimeOut);
                    syncTimeOut = null;
                }
                syncDataWithServer();
            }
            if (done) done();
        });
    });
    if(size>0 || debugMode){
        console.log(`Flushed ${size} records to the database.`);
    }

    
}


//sync data periodically with server from the attendance db
function logFailedSync(payload, error) {
    const line = JSON.stringify({ ts: getCurrentDataTime(), error: String(error && error.message || error), payload }) + '\n';
    fs.appendFile('sync_fail.log', line, (err) => { if (err) console.error('Failed sync log write:', err.message); });
}
function syncDataWithServer() {
    if (syncing) return; // Prevent concurrent syncs
    syncing = true;
    //get unsynced data from the database
    const sql = `SELECT id, date, time, rfid FROM attendance WHERE isSynced = 0`;
    const remoteURL = `${MAIN_PROTOCOL}://${MAIN_DOMAIN}/api/device/save-attendance`;

    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error('Error syncing data with server:', err.message);
            syncing = false;
            syncTimeOut = setTimeout(syncDataWithServer, 30000);
            return;
        }
        const datas = rows.map(row => ({
            id: row.id,
            date: row.date,
            time: row.time,
            rfid: row.rfid,
        }));
        
        
        const ids = datas.map(data => data.id);
        if(ids.length === 0) {
            syncing = false; // Reset the syncing flag
            syncTimeOut = setTimeout(syncDataWithServer, 30000); // Retry every 30 seconds
            return; // No data to sync
        }
        if(debugMode){
            console.log('Synchronizing data with server...');
        }
        const payload = {
            token:LOCAL_TOKEN,
            device_id: DEVICE_ID,
            datas: datas.map(data => ({
                rfid: data.rfid,
                date: data.date,
                time: data.time
            }))
        };
        axios.post(remoteURL, payload)
        .then((res) => {
            //update isSynced to 1 for all ids
            if (res.status === 200 && ids.length > 0) {
                db.serialize(() => {
                    const stmt = db.prepare(`UPDATE attendance SET isSynced = 1 WHERE id IN (${ids.join(',')})`);
                    stmt.run();
                    stmt.finalize();
                });
                if(debugMode){
                    console.log(res.data);
                }

            } else {
                logFailedSync(payload, 'bad status ' + res.status);
            }
        })
        .catch((error) => {
            console.log(error.response ? error.response.data : error.message);
            console.error('Error syncing data with server:', error.message);
            logFailedSync(payload, error.response ? error.response.data : error.message);
        })
        .finally(() => {
            syncing = false; // Reset the syncing flag
            syncTimeOut = setTimeout(syncDataWithServer, 30000); // Retry every 30 seconds
        });
    });
}

// Periodically flush the cache.
const flushTimer = setInterval(() => flushCache(), BATCH_INTERVAL_MS);

var connectionRetry = 1;
// Current date/time in TIMEZONE. ponytail: Intl stdlib, no date lib.
function getCurrentDataTime(){
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
            .formatToParts(new Date()).map(p => [p.type, p.value])
    );
    return { currentDate: `${parts.year}-${parts.month}-${parts.day}`, currentTime: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}:${parts.second}` };
}

function tzDateString(offsetDays = 0){
    const d = new Date(Date.now() + offsetDays * 86400000);
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
            .formatToParts(d).map(p => [p.type, p.value])
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
}

// Hourly cleanup of rows synced 7+ days ago. TZ-computed cutoff, not SQLite UTC now.
function cleanupOldSynced(){
    const cutoff = tzDateString(-7);
    db.run(`DELETE FROM attendance WHERE isSynced = 1 AND date < ?`, [cutoff], function(err){
        if (err) console.error('Cleanup error:', err.message);
        else if (debugMode && this.changes > 0) console.log(`Cleanup deleted ${this.changes} rows older than ${cutoff}.`);
    });
}
const cleanupTimer = setInterval(cleanupOldSynced, 3600000);

function buildInitCommand() {
    const hexString = 'cfff00720017a5';
    // const hexString = 'CFFF0050000000';
    const buffer = Buffer.from(hexString, 'hex');
  
  return buffer;
}

let sockets = {}; // Store sockets by host
let shuttingDown = false;
let webServer = null;

function startServer() {

    function initServerConnection(SERVER_HOST){
        const socket = new net.Socket();
        socket.setKeepAlive(true);
        // socket.setTimeout(60000); // 60 second timeout

        // Store socket reference
        sockets[SERVER_HOST] = socket;

        console.log(`Connecting to TCP server at ${SERVER_HOST}:${SERVER_PORT}...`);
       
        socket.on('data', (data) => {
            // Convert the incoming data buffer to a hexadecimal string.
            const hexMessage = data.toString('hex');
            // console.log('data');
            
            // Extract the RFID: remove the last 4 hex digits then take the last 24 characters.
            const processedHex = hexMessage.slice(0, -4).slice(-24);
            if(debugMode){
                console.log('Received hex string:',SERVER_HOST, processedHex);
            }
            
            lastData = processedHex;

            // Get the current date and time.
            const { currentDate, currentTime } = getCurrentDataTime();
            // Log the RFID and timestamp.
            // console.log(`RFID: ${processedHex}, Date: ${currentDate}, Time: ${currentTime}`);

            // Debounce same RFID within DEVICE_UPDATE_TIME, else queue one insert row.
            const nowMs = Date.now();
            const lastMs = attendanceCache.get(processedHex);
            if (lastMs !== undefined && (nowMs - lastMs) / 1000 <= Number(DEVICE_UPDATE_TIME)) return;
            attendanceCache.set(processedHex, nowMs);
            pendingRows.push({ date: currentDate, time: currentTime, rfid: processedHex });
        });

        socket.on('error', (err) => {
            console.error(`Socket error for ${SERVER_HOST}:`, err.message);
            // Don't reconnect here - let close event handle it
        });

        //handle when server disconnects retry every 5 seconds
        socket.on('close', (hadError) => {
            if (shuttingDown) return;
            if (hadError) {
                console.log(`Connection closed due to error for ${SERVER_HOST}. Reconnecting in 5 seconds...`);
            } else {
                console.log(`Connection closed normally for ${SERVER_HOST}. Reconnecting in 5 seconds...`);
            }
            setTimeout(() => initServerConnection(SERVER_HOST), 5000);
        });

        socket.connect(SERVER_PORT, SERVER_HOST, () => {
            const packet = buildInitCommand();
            console.log(`Sending init command to ${SERVER_HOST}:`, packet.toString('hex'));
            socket.write(packet);
        });

        return socket;
    }

   

    loadAttendanceCache()
    .then(() => {
        try {
            const { startWeb } = require('./web');
            webServer = startWeb({
                db, attendanceCache, pendingRows,
                getSync: () => ({ syncing, lastData, timezone: TIMEZONE, serverPort: SERVER_PORT, serverHosts: SERVER_HOSTS, deviceUpdateTime: DEVICE_UPDATE_TIME, mainDomain: `${MAIN_PROTOCOL}://${MAIN_DOMAIN}`, localToken: LOCAL_TOKEN, deviceId: DEVICE_ID }),
            });
        } catch (e) { console.error('Web panel disabled:', e.message); }
        // Connect to all servers in SERVER_HOSTS
        SERVER_HOSTS.forEach((host) => {
            const trimmedHost = host.trim();
            if (trimmedHost) {
                console.log(`Initializing connection to ${trimmedHost}`);
                initServerConnection(trimmedHost);
            }
        });
    })
    .catch((err) => {
        console.error('Error loading attendance cache:', err);
        process.exit(1);
    });
    // Start the server connection.

    function gracefulShutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`\nShutting down (${signal})...`);
        try { fs.writeFileSync('lastData.txt', lastData); } catch (e) {}
        clearInterval(flushTimer);
        clearInterval(cleanupTimer);
        if (syncTimeOut) clearTimeout(syncTimeOut);
        // Destroy all active sockets
        Object.values(sockets).forEach(socket => {
            try { if (socket) socket.destroy(); } catch (e) {}
        });
        flushCache(() => {
            try { if (insertStmt) insertStmt.finalize(); } catch (e) {}
            const exitTimer = setTimeout(() => process.exit(0), 5000);
            if (exitTimer.unref) exitTimer.unref();
            if (webServer) webServer.close(() => db.close(() => process.exit(0)));
            else db.close(() => process.exit(0));
        });
    }
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}
