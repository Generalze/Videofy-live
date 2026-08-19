/** @author masterzee001 */
/**
 * Process entry: read env, open the durable room registry, build the app,
 * listen on port 8790. The vfk_ key goes into the SDK client and nowhere
 * else — the boot log names the port and the Connect origin only.
 */
import { createVideofyConnect } from '@videofy/server-sdk';
import { buildReferenceApp } from './app.js';
import { readConfig } from './config.js';
import { createFileRoomStore } from './room-store.js';

const config = readConfig(process.env);
const roomStore = await createFileRoomStore(config.roomsPath);
const connect = createVideofyConnect({ apiKey: config.apiKey, baseUrl: config.connectUrl });
const app = buildReferenceApp({ connect, roomStore });

app.listen(config.port, () => {
  console.log(
    `[connect-reference] listening on http://localhost:${config.port} (Connect at ${config.connectUrl})`,
  );
});
