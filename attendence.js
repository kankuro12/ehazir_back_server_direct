const http = require("http");
const express = require("express");
const sqlite3 = require('sqlite3').verbose();

const app = express();
const host = "0.0.0.0";
const port = 3000;

const DEVICE_UPDATE_TIME = 30; 
const BATCH_INTERVAL_MS = 1000;


// Initialize attendance cache
const attendanceCache = new Map();



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


function sendToBackend(data){


}



function startAttendanceServer() {

    http.createServer(app).listen(port, host, () => {
        console.log(`🟢 ZKTeco HTTP ADMS Server running on port ${port}`);
    });
}

// module.exports = { startAttendanceServer };
startAttendanceServer();

