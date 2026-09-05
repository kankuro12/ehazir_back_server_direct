const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = 5000;
const OUTFILE = path.join(__dirname, 'received_data.txt');

const server = net.createServer((socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`Client connected: ${peer}`);

  socket.on('data', (data) => {
    const hexMessage = data.toString('hex');
    const processedHex = hexMessage.slice(0, -4).slice(-24);

    const entry = `${processedHex}\n`;

    fs.appendFile(OUTFILE, entry, (err) => {
      if (err) {
        console.error('Failed to write data:', err);
      }
    });
  });

  socket.on('end', () => {
    console.log(`Client disconnected: ${peer}`);
  });

  socket.on('error', (err) => {
    console.error(`Socket error from ${peer}:`, err);
  });
});

server.on('error', (err) => {
  console.error('Server error:', err);
});

server.listen(PORT, () => {
  console.log(`TCP listener running on port ${PORT}`);
});
