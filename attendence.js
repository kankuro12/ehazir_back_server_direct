require('dotenv').config();
const http = require("http");
const express = require("express");
const axios = require("axios");

const app = express();
const host = "0.0.0.0";
const port = 3000;

const BUFFER_TIME = process.env.BUFFER_TIME  * 60 * 1000; 
console.log('Using BUFFER_TIME (ms):', BUFFER_TIME);
const BATCH_INTERVAL_MS = 60000;

const attendanceCache = new Map();

app.use((req, res, next) => {
    let data = "";
    req.setEncoding("utf8");

    req.on("data", chunk => (data += chunk));
    req.on("end", () => {
        req.rawBody = data;
        next();
    });
});

app.all("/iclock/getrequest", (req, res) => {
    res.send("OK");
});

app.all("/iclock/registry", (req, res) => {
    res.send("OK");
});

app.all("/iclock/cdata", (req, res) => {
    const records = parseAttendance(req.rawBody);

    records.forEach(cacheAttendance);

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
                userId: cols[0],
                punchTime: cols[1],
                inOutMode: cols[2],
                verifyMode: cols[3],
            };
        });
}

function cacheAttendance(record) {
    const now = Date.now();
    const key = record.userId;

    const cached = attendanceCache.get(key);

    if (cached && now - cached.timestamp < BUFFER_TIME) {
        console.log(`Duplicate ignored for user ${record.userId} within ${(now - cached.timestamp) / 1000}s`);
        return;
    }

    attendanceCache.set(key, {
        record,
        timestamp: now,
        sent: false, // Track if this record has been sent
    });
    console.log(`Cached attendance for user ${record.userId}`);
}

async function flushAttendanceCache() {
    const now = Date.now();

    // Only get records that haven't been sent yet
    const unsent = [];
    for (const [key, value] of attendanceCache.entries()) {
        if (!value.sent) {
            unsent.push(value.record);
        }
    }

    // If there are unsent records, send them
    if (unsent.length > 0) {
        console.log('payload', unsent);

        try {
            await axios.post(
                "http://localhost:8000/api/staff/attendance",
                { records: unsent },
                { timeout: 5000 }
            );

            // Mark records as sent
            for (const [key, value] of attendanceCache.entries()) {
                if (!value.sent) {
                    value.sent = true;
                }
            }
        } catch (error) {
            console.error(
                "❌ Backend error:",
                error.response?.data || error.message
            );
        }
    }

    for (const [key, value] of attendanceCache.entries()) {
        if (now - value.timestamp >= BUFFER_TIME) {
            attendanceCache.delete(key);
        }
    }
}

setInterval(flushAttendanceCache, BATCH_INTERVAL_MS);

function startAttendanceServer() {
    http.createServer(app).listen(port, host, () => {
        console.log(`🟢 ZKTeco HTTP ADMS Server running on ${port}`);
    });
}

startAttendanceServer();
