const { generateRandomString, readFromTerminal } = require('./helper');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { env } = require('process');


const envExampleFilePath = path.join(__dirname, '.env.example');


function setupEnv(){
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(envExampleFilePath)) {
            console.error('.env.example file not found.');
            reject(new Error('.env.example file not found.'));
        }
        else{
            const envContent = fs.readFileSync(envExampleFilePath, 'utf-8');
            const envLines = envContent.split('\n');
            const envVars = {};
        
            envLines.forEach(line => {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    const [key, ...rest] = trimmed.split('=');
                    let value = rest.join('=');
                    envVars[key] = value;
                }
            });
        
            const questions = Object.keys(envVars)
                .filter(key => key !== 'DEVICE_ID' && key !== 'LOCAL_TOKEN')
                .map(key => {
                    return {
                        key,
                        question: `Enter value for ${key} (${envVars[key]}): `,
                        default: envVars[key]
                    };
                });
        
            (async () => {
                const answers = {};
                for (const q of questions) {
                    let answer = await readFromTerminal(q.question);
                    answers[q.key] = answer || q.default;
                }
                // Add DEVICE_ID and LOCAL_TOKEN with their default values (possibly empty)
                if ('DEVICE_ID' in envVars) answers['DEVICE_ID'] = envVars['DEVICE_ID'];
                if ('LOCAL_TOKEN' in envVars) answers['LOCAL_TOKEN'] = envVars['LOCAL_TOKEN'];
                const newEnv = Object.entries(answers)
                    .map(([k, v]) => `${k}=${v}`)
                    .join('\n');
                fs.writeFileSync(path.join(__dirname, '.env'), newEnv, 'utf-8');
                resolve();
                console.log('.env file created successfully.');
            })();
        }
    });

}



// load from .env 
setupEnv()
.then(() => {
    require('dotenv').config();
    
    const DEVICE_ID = process.env.DEVICE_ID;
    const LOCAL_TOKEN = process.env.LOCAL_TOKEN;
    const SERVER_HOST = process.env.SERVER_HOST;
    const SERVER_PORT = process.env.SERVER_PORT;
    const MAIN_DOMAIN = process.env.MAIN_DOMAIN;
    const MAIN_PROTOCOL = process.env.MAIN_PROTOCOL;
    const DEVICE_UPDATE_TIME = process.env.DEVICE_UPDATE_TIME;
    
    if (!fs.existsSync(path.join(__dirname, '.env'))) {
        console.log('.env file not found, creating a new one from .env.example');
    }

    console.log(`DEVICE_ID: ${DEVICE_ID}, LOCAL_TOKEN: ${LOCAL_TOKEN}, SERVER_HOST: ${SERVER_HOST}, SERVER_PORT: ${SERVER_PORT}, MAIN_DOMAIN: ${MAIN_DOMAIN}, MAIN_PROTOCOL: ${MAIN_PROTOCOL}, DEVICE_UPDATE_TIME: ${DEVICE_UPDATE_TIME}`);

    // Check if all required environment variables are set
    const url = 'https://files.ehazircloud.com/ask.php?ask=token';

    // Continue with the rest of your application logic here
    axios.get(url)
    .then(response => {
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
                    const envFilePath = __dirname + '/.env';

                    let envContent = fs.readFileSync(envFilePath, 'utf8');
                    //check if LOCAL_TOKEN already exists
                    if (envContent.includes('LOCAL_TOKEN=')) {
                        envContent = envContent.replace(/LOCAL_TOKEN=.*/g, `LOCAL_TOKEN=${local_token}`);
                    } else {
                        // Append LOCAL_TOKEN
                        envContent += `\nLOCAL_TOKEN=${local_token}`;
                    }   
    
                    //for device id
                    if (envContent.includes('DEVICE_ID=')) {
                        // Replace existing DEVICE_ID
                        envContent = envContent.replace(/DEVICE_ID=.*/g, `DEVICE_ID=${deviceId}`);
                    } else {
                        // Append DEVICE_ID
                        envContent += `\nDEVICE_ID=${deviceId}`;
                    }

                    fs.writeFileSync(envFilePath, envContent, 'utf8');
                    console.log('Device registered successfully.');
                    console.log(`LOCAL_TOKEN: ${local_token}, DEVICE_ID: ${deviceId}`);

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
    



})    
.catch(err => {
    console.error('Error setting up environment:', err);
    process.exit(1);
});


