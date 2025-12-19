require('dotenv').config();

const net = require('net');
const sqlite3 = require('sqlite3').verbose();
   
const path = require('path');
const https = require('https');
const fs = require('fs');
const { default: axios } = require('axios');


const SERVER_PORT = process.env.SERVER_PORT || 5000;
const SERVER_HOST = process.env.SERVER_HOST ;

const MAIN_DOMAIN = process.env.MAIN_DOMAIN || 'localhost:8000';
const MAIN_PROTOCOL = process.env.MAIN_PROTOCOL || 'http';
const LOCAL_TOKEN = process.env.LOCAL_TOKEN || 'your_local_token';
const DEVICE_ID = process.env.DEVICE_ID || 'your_device_id';
const DEVICE_UPDATE_TIME = process.env.DEVICE_UPDATE_TIME || 30; // in seconds
 
const debugMode = true;

// if (!debugMode) {
//     console.log = function () { };
// }


// Open (or create) the database.
const db = new sqlite3.Database('./attendance1.db', (err) => {
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

// Use serialize to ensure sequential execution.
db.serialize(() => {
    // Create the table if it doesn't exist.
    db.run(`
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,         -- Format: 'YYYY-MM-DD'
      rfid TEXT NOT NULL CHECK (length(rfid) = 24),
      intime TEXT NOT NULL,       -- First time the RFID is read
      outtime TEXT,               -- Last time the RFID is read
      isSynced INTEGER DEFAULT 0, -- 0 = not synced, 1 = synced
      UNIQUE(date, rfid)
    )
  `, (err) => {
        if (err) {
            console.error('Table creation error:', err);
            process.exit(1);
        }

        // Start the TCP server only after the table is created.
        startServer();
    });
});

// In-memory cache for attendance records for the current day.
// Keyed by RFID; each value is an object:
// { date, intime, outtime, isNew, updated }
const attendanceCache = new Map();

//load attendance cahche from the database
function loadAttendanceCache() {
    return new Promise((resolve, reject) => {
        const sql = `SELECT date, rfid, intime, outtime, isSynced FROM attendance WHERE date = ?`;
        const today = new Date().toISOString().split('T')[0]; // Get today's date in 'YYYY-MM-DD' format

        db.all(sql, [today], (err, rows) => {
            if (err) {
                console.error('Error loading attendance cache:', err);
                reject(err);
            } else {
                console.log('Attendance cache loaded successfully.');
                rows.forEach(row => {
                    attendanceCache.set(row.rfid, {
                        date: row.date,
                        intime: row.intime,
                        outtime: row.outtime,
                        isNew: false,
                        updated: false
                    });
                });
                resolve();
            }
        });
    });
}

// Batch flush interval (in milliseconds)
const BATCH_INTERVAL_MS = 1000;

// Prepare statements for insertion and update.
const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO attendance (date, rfid, intime, outtime)
  VALUES (?, ?, ?, ?)
`);
const updateStmt = db.prepare(`
  UPDATE attendance SET outtime = ?,isSynced = 0
  WHERE date = ? AND rfid = ?
`);

// Function to flush cached records to the database in a transaction.
function flushCache() {
    if (attendanceCache.size === 0) return;

    let size=0;

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        attendanceCache.forEach((record, rfid) => {
            if (record.isNew) {
                // Insert new record. Using INSERT OR IGNORE in case a record was concurrently inserted.
                insertStmt.run(record.date, rfid, record.intime, record.outtime, (err) => {
                    if (err) console.error(`Insert error for ${rfid}:`, err);
                });
                size++;

            } else if (record.updated) {
                // Update outtime.
                updateStmt.run(record.outtime, record.date, rfid, (err) => {
                    if (err) console.error(`Update error for ${rfid}:`, err);
                });
                size++;
            }
            // Reset flags after flushing.
            record.isNew = false;
            record.updated = false;
        });
        db.run('COMMIT');
        if(!syncing){
            if(syncTimeOut){
                clearTimeout(syncTimeOut);
                syncTimeOut = null;
            }
            syncDataWithServer();
        }
    });
    if(size>0 || debugMode){
        console.log(`Flushed ${size} records to the database.`);
    }

    
}


//sync data periodically with server from the attendance db
function syncDataWithServer() {
    if (syncing) return; // Prevent concurrent syncs
    syncing = true;
    //get unsynced data from the database
    const sql = `SELECT id, date, rfid, intime, outtime FROM attendance WHERE isSynced = 0`;
    const remoteURL = `${MAIN_PROTOCOL}://${MAIN_DOMAIN}/api/device/set`;

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
            rfid: row.rfid,
            in_time: row.intime,
            out_time: row.outtime,
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
        axios.post(remoteURL, {
            token:LOCAL_TOKEN,
            device_id: DEVICE_ID,
            datas: datas.map(data => ({
                rfid: data.rfid,
                in_time: data.in_time,
                out_time: data.out_time,
                date: data.date
            }))
        })
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

            }
        })
        .catch((error) => {
            console.log(error.response ? error.response.data : error.message);
            console.error('Error syncing data with server:', error.message);
        })
        .finally(() => {
            syncing = false; // Reset the syncing flag
            syncTimeOut = setTimeout(syncDataWithServer, 30000); // Retry every 30 seconds
        });
    });
}

// Periodically flush the cache.
setInterval(flushCache, BATCH_INTERVAL_MS);

var connectionRetry = 1;
// Function to start the TCP server.
function getCurrentDataTime(){
    const now = new Date();

    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');

    const formattedTime = `${hours}:${minutes}:${seconds}`;

    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');

    const formattedDate = `${year}-${month}-${day}`;
    return { currentDate: formattedDate, currentTime: formattedTime };
}

function buildInitCommand() {
    const hexString = 'cfff00720017a5';
    // const hexString = 'CFFF0050000000';
    const buffer = Buffer.from(hexString, 'hex');
  
  return buffer;
}

let socket = null;
let fromRetry = false;

function startServer() {

    function initServerConnection(){
        socket = new net.Socket();
        socket.setKeepAlive(true);
        // socket.setTimeout(60000); // 60 second timeout



        console.log(`Connecting to TCP server at ${SERVER_HOST}:${SERVER_PORT}...`);
       
        socket.on('data', (data) => {
            // Convert the incoming data buffer to a hexadecimal string.
            const hexMessage = data.toString('hex');
            // console.log('data');
            
            // Extract the RFID: remove the last 4 hex digits then take the last 24 characters.
            const processedHex = hexMessage.slice(0, -4).slice(-24);
            if(debugMode){
                console.log('Received hex string:', processedHex);
            }
            
            lastData = processedHex;

            // Get the current date and time.
            const { currentDate, currentTime } = getCurrentDataTime();
            // Log the RFID and timestamp.
            // console.log(`RFID: ${processedHex}, Date: ${currentDate}, Time: ${currentTime}`);

            // If the cache already has an entry for this RFID, update the outtime.
            if (attendanceCache.has(processedHex)) {
                const record = attendanceCache.get(processedHex);
                // If the date has changed (i.e. new day), clear the cache.
                if (record.date !== currentDate) {
                    attendanceCache.clear();
                } else {
                    //currrent record should be atleast DEVICE_UPDATE_TIME seconds newer
                    const lastOutTime = new Date(`${record.date} ${record.outtime}`);
                    const currentOutTime = new Date(`${currentDate} ${currentTime}`);
                    const timeDiff = (currentOutTime - lastOutTime) / 1000; // in seconds
                    if (timeDiff > DEVICE_UPDATE_TIME) {
                        record.outtime = currentTime;
                        record.updated = true;
                    }
                    return;
                }
            }

            // For a new RFID for the day, add a new record to the cache.
            attendanceCache.set(processedHex, {
                date: currentDate,
                intime: currentTime,
                outtime: currentTime,
                isNew: true,
                updated: false
            });
        });

        socket.on('timeout', () => {
            console.log('Connection timeout');
            fromRetry = true;
            socket.destroy();
        });

        socket.on('error', (err) => {
            console.error('Socket error:', err.message);
            // Don't reconnect here - let close event handle it
        });

        //handle when server disconnects retry eve 5 seconds
        socket.on('close', (hadError) => {
            if (hadError) {
                console.log('Connection closed due to error. Reconnecting in 5 seconds...', connectionRetry++);
            } else {
                console.log('Connection closed normally. Reconnecting in 5 seconds...', connectionRetry++);
            }
            setTimeout(initServerConnection, fromRetry?1:5000);
        });

        socket.connect(SERVER_PORT, SERVER_HOST, () => {
            connectionRetry = 1;
            socket.setTimeout(10000); // 10 second timeout
            fromRetry = false;
            const packet = buildInitCommand();
            console.log('Sending init command:', packet.toString('hex'));
            socket.write(packet);
        });

        return socket;
    }

   

    loadAttendanceCache()
    .then(() => {
        initServerConnection();
    })
    .catch((err) => {
        console.error('Error loading attendance cache:', err);
        process.exit(1);
    });
    // Start the server connection.
    
    process.on('SIGINT', () => {
        //save last data to a file 
        fs.writeFileSync('lastData.txt', lastData);
        console.log('\nShutting down...');
        flushCache();
        insertStmt.finalize();
        updateStmt.finalize();
        db.close();
        if (socket) socket.destroy();
        process.exit(0);
    });
}
