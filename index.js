const http = require('http');
const express = require('express');
const Docker = require('dockerode')
const httpProxy = require('http-proxy');

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const proxy = httpProxy.createProxy();

const db = new Map();

docker.getEvents((err, stream) => {
    if (err) {
        console.log('Error on getEvents', err)
        return;
    }

    stream.on('data', async(chunk) => {
        try {
            if (!chunk) return;

            const event = JSON.parse(chunk.toString());
    
            if(event.Type === 'container' && event.Action === 'start') {
                const container = docker.getContainer(event.id);
                const containerInfo = await container.inspect();
    
                const containerName = containerInfo.Name.substring(1);
                const ipAddress = containerInfo.NetworkSettings.IPAddress;
                const expostedPort = Object.keys(containerInfo.Config.ExposedPorts);
    
                if (expostedPort && expostedPort.length > 0) {
                    let defaultPort = null;
                    const [port, type] = expostedPort[0].split('/');
    
                    if(type === 'tcp') {
                        defaultPort = port;
                    }
                    console.log(`Registring ${containerName}.locahost ---> http://${ipAddress}:${defaultPort}`);
                    db.set(containerName, {containerName, ipAddress, defaultPort});
                }
            }
        } catch(error) {
            console.log('Error from docker event listener', error);
        }
    })
});

const reverseProxyApp = express();

reverseProxyApp.use((req,res)=> {
    const hostName = req.hostname;
    const subDomain = hostName.split('.')[0];

    if(!db.has(subDomain)) return res.status(404).end(404);

    const {ipAddress, defaultPort} = db.get(subDomain);

    const target = `http://${ipAddress}:${defaultPort}`;

    console.log(`Forwading ${hostName} --> ${target}`)

    return proxy.web(req, res, {target, changeOrigin: true, ws: true});
})

const reverseProxy = http.createServer(reverseProxyApp);

reverseProxy.on('upgrade', (req,socket,head) => {
    try {
        const hostName = req.headers.host;
        const subDomain = hostName.split('.')[0];
    
        if(!db.has(subDomain)) return res.status(404).end(404);
    
        const {ipAddress, defaultPort} = db.get(subDomain);
    
        const target = `http://${ipAddress}:${defaultPort}`;
    
        return proxy.ws(req, socket, head, {
            target: target,
            ws: true
        });
    } catch (error) {
        console.log('Error from ws upgrade listener', error);
    }

});

const managementAPI = express();

managementAPI.use(express.json())

// managementAPI.post('/containers', async (req,res) => {
//     const {image, tag = 'latest'} = req.body;
//     const imageAlreadyExist = false;

//     const images = await docker.listImages();

//     for(const systemImage of images) {
//         for(const systemTag of systemImage) {
//             if (systemTag === `${image}:${tag}`) {
//                 imageAlreadyExist = true;
//                 break;
//             }
//         }
//         if (imageAlreadyExist) break;
//     }

//     if (!imageAlreadyExist) {
//         console.log(`Pulling ${image}:${tag}`);
//         await docker.pull(`${image}:${tag}`);
//     }

//     const container = await docker.createContainer({
//         Image: `${image}:${tag}`,
//         Tty: false,
//         HostConfig: {
//             AutoRemove: true
//         }
//     })

//     await container.start();

//     return res.json({status: 'success', container: `${(await container.inspect()).Name}.docker.localhost`});
// });

managementAPI.post('/containers', async (req, res) => {
    const { containerName, repoUrl, tag = 'latest' } = req.body;

    const image = 'codercom/code-server';
    const imageTag = `${image}:${tag}`;
    const images = await docker.listImages();
    
    const imageExists = images.some(systemImage => 
        systemImage.RepoTags && systemImage.RepoTags.includes(imageTag)
    );

    if (!imageExists) {
        console.log(`Pulling ${imageTag}`);
        await docker.pull(imageTag);
    }

    const container = await docker.createContainer({
        Image: imageTag,
        name: containerName,
        Tty: true,
        Cmd: ['/bin/bash']
    });

    await container.start();

    const containerInfo = await container.inspect();
    console.log(containerInfo.State.Status);

    await new Promise(resolve => setTimeout(resolve, 5000));

    const configPath = '/home/coder/.config/code-server/config.yaml';

    container.exec({
        AttachStdout: true,
        AttachStderr: true,
        Cmd: ['bash', '-c', `git clone ${repoUrl} /home/coder/project && cat ${configPath}`],
    }, function(err, exec) {
        console.log('****error',err);
        if (err) {
            return res.status(500).json({ error: 'Failed to create exec instance.' });
        }

        exec.start({ hijack: true, stdout: true, stderr: true }, function(err, stream) {
            if (err) {
                return res.status(500).json({ error: 'Failed to start exec instance.' });
            }

            let configData = '';
            stream.on('data', (data) => {
                configData += data.toString();
            });

            stream.on('end', async () => {
                const passwordMatch = configData.match(/password:\s*(.+)/);
                const password = passwordMatch ? passwordMatch[1].trim() : 'Password not found';

                return res.json({
                    status: 'success',
                    container: `${containerName}.localhost/?folder=/home/coder/project`,
                    password: password
                });
            });

            stream.on('error', (streamErr) => {
                console.error('Stream error:', streamErr);
                return res.status(500).json({ error: 'Error reading config file.' });
            });
        });
    });
});



managementAPI.listen(8080, () => {
    console.log('Management API is running on PORT 8080')
});
reverseProxy.listen(80, () => {
    console.log('Reverse proxy is running on PORT 80')
});
