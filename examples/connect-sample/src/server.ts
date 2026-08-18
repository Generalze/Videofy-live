/** @author masterzee001 */
/**
 * Entry point: read env, build the SDK client, serve the two pages.
 * Startup logging names ports and URLs only — never the API key.
 */
import { createServer } from 'node:http';
import { createVideofyConnect } from '@videofy/server-sdk';
import { buildSampleApp } from './app.js';
import { readSampleConfig } from './config.js';
import { connectSdkDistDir, samplePublicDir, socketIoClientDistDir } from './paths.js';

const config = readSampleConfig(process.env);

const connect = createVideofyConnect({
  apiKey: config.apiKey,
  baseUrl: config.videofyUrl,
});

const app = buildSampleApp({
  connect,
  videofyUrl: config.videofyUrl,
  publicDir: samplePublicDir(),
  connectSdkDistDir: connectSdkDistDir(),
  socketIoClientDistDir: socketIoClientDistDir(),
});

const server = createServer(app);
server.listen(config.port, () => {
  console.log(`connect-sample listening on http://localhost:${config.port}`);
  console.log(`Videofy Connect API expected at ${config.videofyUrl}`);
  console.log('Open the page above, create a video chat, and share its join links.');
});
