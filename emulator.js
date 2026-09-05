const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = process.env.EMULATOR_PORT || 2022;
const BURST_MIN_MS = Number(process.env.EMU_BURST_MIN_MS || 10 * 1000);
const BURST_MAX_MS = Number(process.env.EMU_BURST_MAX_MS || 60 * 1000);
const RFID_FILE = path.join(__dirname, 'emulator_rfids.txt');
const SUFFIX = 'abcd';
let clients = [];
let clientID = 0;

function randomHex(n) {
    let s = '';
    for (let i = 0; i < n; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)];
    return s;
}
function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

let rfids;
if (fs.existsSync(RFID_FILE)) {
    rfids = fs.readFileSync(RFID_FILE, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => /^[0-9a-fA-F]{24}$/.test(l));
    console.log(`Loaded ${rfids.length} RFIDs from file.`);
}
if (!rfids || rfids.length === 0) {
    rfids = Array.from({ length: 20 }, () => randomHex(24));
    fs.writeFileSync(RFID_FILE, rfids.join('\n'), 'utf8');
    console.log(`Generated and saved ${rfids.length} fixed RFIDs.`);
}

function broadcast(rfid) {
    const buf = Buffer.from(rfid + SUFFIX, 'hex');
    clients.forEach(c => { if (c.socket && !c.socket.destroyed) c.socket.write(buf); });
    console.log(`Sent ${rfid} to ${clients.length} client(s)`);
}

function scheduleBurst() {
    const n = Math.random() < 0.5 ? 4 : 5;
    for (let i = 0; i < n; i++) broadcast(rfids[Math.floor(Math.random() * rfids.length)]);
    const pauseMs = randomInt(BURST_MIN_MS, BURST_MAX_MS);
    console.log(`Next burst in ${Math.round(pauseMs / 1000)}s`);
    setTimeout(scheduleBurst, pauseMs);
}

const server = net.createServer((socket) => {
    const id = clientID++;
    clients.push({ socket, id });
    console.log(`Client ${id} connected`);
    socket.on('data', (d) => console.log(`Init from ${id}: ${d.toString('hex')}`));
    const drop = () => { clients = clients.filter(c => c.id !== id); console.log(`Client ${id} gone`); };
    socket.on('close', drop);
    socket.on('error', (e) => { console.log(`Socket ${id} err: ${e.message}`); drop(); });
});

server.listen(PORT, () => console.log(`Emulator on port ${PORT}`));
setTimeout(scheduleBurst, 1000);
process.on('SIGINT', () => { clients.forEach(c => c.socket.destroy()); server.close(() => process.exit(0)); });
