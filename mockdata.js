const http = require("http");

const TARGET_HOST = "localhost";
const TARGET_PORT = 3000;
const TARGET_PATH = "/iclock/cdata";

function generateMockAttendance() {
    const userId = String(Math.floor(Math.random() * 3) + 1);

    const now = new Date();
    const dateTime =
        now.getFullYear() + "-" +
        String(now.getMonth() + 1).padStart(2, "0") + "-" +
        String(now.getDate()).padStart(2, "0") + " " +
        String(now.getHours()).padStart(2, "0") + ":" +
        String(now.getMinutes()).padStart(2, "0") + ":" +
        String(now.getSeconds()).padStart(2, "0");

    const inOutMode = String(Math.random() > 0.5 ? 1 : 2);
    const verifyMode = String(Math.random() > 0.5 ? 4 : 2);

    // EXACT format your parser expects
    return `${userId}\t${dateTime}\t${inOutMode}\t${verifyMode}`;
}

function sendMockData() {
    const body = generateMockAttendance();

    const req = http.request(
        {
            hostname: TARGET_HOST,
            port: TARGET_PORT,
            path: TARGET_PATH,
            method: "POST",
            headers: {
                "Content-Type": "text/plain",
                "Content-Length": Buffer.byteLength(body),
            },
        },
        res => {
            res.on("data", () => {});
            res.on("end", () => {
                console.log("Mock sent:", body);
            });
        }
    );

    req.on("error", err => {
        console.error("Mock send failed:", err.code, err.message);
    });

    req.write(body);
    req.end();
}

setInterval(sendMockData, 10000);

console.log("Mock ZKTeco device started");
