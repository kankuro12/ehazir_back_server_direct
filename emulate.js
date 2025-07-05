const net = require('net');
const fs = require('fs');
const path = require('path');
let clients = [];
var clientID = 0;

function random50letters() {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    let result = '';
    for (let i = 0; i < 50; i++) {
        result += letters.charAt(Math.floor(Math.random() * letters.length));
    }
    return result;
}
function broadcastToClients(data) {
    console.log(clients.length, 'Broadcasting to clients:', data);
    
    clients.forEach(client => {
        if (client.socket && !client.socket.destroyed) {
            client.socket.write(data + '\n');
        }
    });
}

var rfids = new Set(); // Set to store unique RFID values

const rfidFile = path.join(__dirname, 'rfid.txt');

if (fs.existsSync(rfidFile)) {
    const fileData = fs.readFileSync(rfidFile, 'utf8');
    fileData.split(/\r?\n/).forEach(line => {
        const trimmed = line.trim();
        if (trimmed) {
            rfids.add(trimmed);
        }
    });
    console.log(`Loaded ${rfids.size} RFID values from file.`);
    
}else{

    for (let index = 0; index < 1000; index++) {
        const element = random50letters();
        rfids.add(element);
    }
    fs.writeFileSync(rfidFile, Array.from(rfids).join('\n'), 'utf8');
    console.log(`Generated and saved ${rfids.size} random RFID values to file.`);
}

// Create TCP server
const server = net.createServer((socket) => {
    console.log('New client connected');
    const id = clientID++;
    clients.push({socket, id});

    socket.on('data', (data) => {
        console.log(`Received message from client ${id}: ${data.toString().trim()}`);
    });

    socket.on('close', () => {
        clients = clients.filter(client => client.id !== id);
        console.log(`Client ${id} disconnected`);
    });

    socket.on('error', (err) => {
        console.log(`Socket error from client ${id}:`, err.message);
        clients = clients.filter(client => client.id !== id);
    });
});

//broadcast to clients on 1 second
setInterval(() => {
    const data = Array.from(rfids)[Math.floor(Math.random() * rfids.size)];
    // console.log(`Broadcasting: ${data}`);
    broadcastToClients(data);
}, 10);

// start TCP server
server.listen(2022, () => {
    console.log('TCP server is running on port 2022');
});

