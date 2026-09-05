const http = require("http");
const express = require("express");
const sqlite3 = require('sqlite3').verbose();

const app = express();
const host = "0.0.0.0";
const port = 3000;

const DEVICE_UPDATE_TIME = 30; // in seconds
const BATCH_INTERVAL_MS = 1000;

// Initialize database
const db = new sqlite3.Database('./attendance1.db', (err) => {
    if (err) {
        console.error('Could not open database:', err);
        process.exit(1);
    }
});

// Initialize attendance cache
const attendanceCache = new Map();

// Configure SQLite for better write concurrency
db.run('PRAGMA journal_mode = WAL;');

// Create table and prepare statements
db.serialize(() => {
    // Create the table if it doesn't exist
    db.run(`
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      rfid TEXT NOT NULL CHECK (length(rfid) = 24),
      intime TEXT NOT NULL,
      outtime TEXT,
      isSynced INTEGER DEFAULT 0,
      UNIQUE(date, rfid)
    )
  `, (err) => {
        if (err) {
            console.error('Table creation error:', err);
            process.exit(1);
        }
        console.log('✅ Database table ready');
    });
});

// Prepare statements for insertion and update
const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO attendance (date, rfid, intime, outtime)
  VALUES (?, ?, ?, ?)
`);
const updateStmt = db.prepare(`
  UPDATE attendance SET outtime = ?, isSynced = 0
  WHERE date = ? AND rfid = ?
`);

app.use((req, res, next) => {
    let data = "";
    req.setEncoding("utf8");

    req.on("data", chunk => {
        data += chunk;
    });

    req.on("end", () => {
        req.rawBody = data;
        next();
    });
});

app.all("/iclock/getrequest", (req, res) => {
    console.log("📡 getrequest:", req.query);
    res.send("OK");
});

app.all("/iclock/registry", (req, res) => {
    console.log("📝 registry:", req.rawBody || req.query);
    res.send("OK");
});

app.all("/iclock/cdata", (req, res) => {
    console.log("📥 RAW ATTENDANCE DATA:", req.rawBody);

    const records = parseAttendance(req.rawBody);
    console.log("✅ PARSED RECORDS:", records);

    // Save each record to the database
    records.forEach(record => {
        saveAttendanceRecord(record);
    });

    res.send("OK");
});

function parseAttendance(raw) {
    if (!raw) return [];
    
    return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(line => {
            const cols = line.split("\t");
            return {
                userId: cols[0],        // Column 1: User PIN/ID
                punchTime: cols[1],     // Column 2: Punch DateTime
                verifyMode: cols[2],    // Column 3: Verify Mode
                inOutMode: cols[3],     // Column 4: In/Out Mode (1=in, 2=out)
                workCode: cols[4]       // Column 5: Work Code
            };
        });
}

function saveAttendanceRecord(record) {
    const userId = record.userId;
    const punchDateTime = record.punchTime; // e.g., "2026-01-04 18:55:46"
    const [currentDate, currentTime] = punchDateTime.split(" ");

    // Convert userId to 24-character RFID format (pad with leading zeros)
    const rfid = userId.padStart(24, '0');

    // Check if record exists in cache
    if (attendanceCache.has(rfid)) {
        const cachedRecord = attendanceCache.get(rfid);
        
        // If the date has changed, clear the cache
        if (cachedRecord.date !== currentDate) {
            attendanceCache.clear();
        } else {
            // Check if enough time has passed since last update
            const lastOutTime = new Date(`${cachedRecord.date} ${cachedRecord.outtime}`);
            const currentOutTime = new Date(punchDateTime);
            const timeDiff = (currentOutTime - lastOutTime) / 1000; // in seconds
            
            if (timeDiff > DEVICE_UPDATE_TIME) {
                cachedRecord.outtime = currentTime;
                cachedRecord.updated = true;
            }
            return;
        }
    }

    attendanceCache.set(rfid, {
        date: currentDate,
        intime: currentTime,
        outtime: currentTime,
        isNew: true,
        updated: false
    });

    console.log(`📝 Saved attendance for User ${userId} at ${punchDateTime}`);
}

function flushCache() {
    if (attendanceCache.size === 0) return;

    let size = 0;

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        attendanceCache.forEach((record, rfid) => {
            if (record.isNew) {
                insertStmt.run(record.date, rfid, record.intime, record.outtime, (err) => {
                    if (err) console.error(`Insert error for ${rfid}:`, err);
                });
                size++;
            } else if (record.updated) {
                updateStmt.run(record.outtime, record.date, rfid, (err) => {
                    if (err) console.error(`Update error for ${rfid}:`, err);
                });
                size++;
            }
            // Reset flags after flushing
            record.isNew = false;
            record.updated = false;
        });
        db.run('COMMIT');
    });

    if (size > 0) {
        console.log(`💾 Flushed ${size} records to the database.`);
    }
}

// Periodically flush the cache
setInterval(flushCache, BATCH_INTERVAL_MS);

function startAttendanceServer() {

    http.createServer(app).listen(port, host, () => {
        console.log(`🟢 ZKTeco HTTP ADMS Server running on port ${port}`);
    });
}

// module.exports = { startAttendanceServer };
startAttendanceServer();

