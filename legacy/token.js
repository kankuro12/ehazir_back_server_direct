const axios = require('axios');
const { generateRandomString, readFromTerminal } = require('./helper');

const url = 'https://files.ehazircloud.com/ask.php?ask=token';
//LOAD FROM .ENV
require('dotenv').config();

const MAIN_DOMAIN = process.env.MAIN_DOMAIN || 'localhost:8000';
const MAIN_PROTOCOL = process.env.MAIN_PROTOCOL || 'http';


axios.get(url)
  .then(response => {
    //read token from terminal
    readFromTerminal().then(token => {

        if(token && token.trim() !== '') {
            const local_token = generateRandomString(32);
            const deviceId = generateRandomString(16);
            axios.post(`${MAIN_PROTOCOL}://${MAIN_DOMAIN}/api/device/register`,{
                token: token.trim(),
                local_token: local_token,
                device_id: deviceId
            })
            .then(response => {
                //append local_token to .env file
                const fs = require('fs');
                const envFilePath = '.env';
                const envContent = fs.readFileSync(envFilePath, 'utf8');
                //check if LOCAL_TOKEN already exists
                if (envContent.includes('LOCAL_TOKEN=')) {
                    // Replace existing LOCAL_TOKEN
                    const newEnvContent = envContent.replace(/LOCAL_TOKEN=.*/g, `LOCAL_TOKEN=${local_token}`);
                    fs.writeFileSync(envFilePath, newEnvContent, 'utf8');
                } else {
                    // Append LOCAL_TOKEN
                    fs.appendFileSync(envFilePath, `\nLOCAL_TOKEN=${local_token}`, 'utf8');
                }   

                //for device id
                if (envContent.includes('DEVICE_ID=')) {
                    // Replace existing DEVICE_ID
                    const newEnvContent = envContent.replace(/DEVICE_ID=.*/g, `DEVICE_ID=${deviceId}`);
                    fs.writeFileSync(envFilePath, newEnvContent, 'utf8');
                } else {
                    // Append DEVICE_ID
                    fs.appendFileSync(envFilePath, `\nDEVICE_ID=${deviceId}`, 'utf8');
                }

            })
            .catch(error => {
                console.log(error.response ? error.response.data : error.message);

                console.error('Error registering device:', error.message);
            });
        }
    });



  })
  .catch(error => {
    console.log(error.response ? error.response.data : error.message);
    
    console.error('Error:', error.message);
  });