const axios = require('axios');
const fs = require('fs');
const https = require('https');
const { url } = require('inspector');

// Create HTTPS agent to handle self-signed certificates
const agent = new https.Agent({ 
    rejectUnauthorized: false,
    requestCert: false,
    agent: false,
    secureProtocol: 'TLS_method'
});

// Set global axios defaults for SSL
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;

// Configure axios defaults
axios.defaults.httpsAgent = agent;
axios.defaults.timeout = 30000;

//read tokens from file
const tokens = fs.readFileSync('tokens.csv', 'utf8').trim().split('\n').map(line => line.split(',')).map(parts => ({
    url: parts[0],
    device_id: parts[1],
    token: parts[2]
}));

tokens.forEach(element => {
    console.log(`Updating device at ${element.url} with ID ${element.device_id}...`);
    
    axios.post(`https://${element.url}/api/device/git`, {
        device_id: element.device_id,
        token: element.token
    }, {
        httpsAgent: agent
    })
    .then(response => {
        console.log(`Response from ${element.url}:`, response.data);
    })
    .catch(error => {
        console.error(`Error updating ${element.url}:`, error.response ? error.response.data : error.message);
    });
});