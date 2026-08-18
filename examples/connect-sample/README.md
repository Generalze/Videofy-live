# Videofy Connect sample partner app

The P6.5 acceptance vehicle (spec R18): a deliberately small, framework-free partner app that
uses **only the public Videofy surfaces** —

- an Express server holding the project key and driving `@videofy/server-sdk`
  (create video chats, mint single-use join tokens, read state, end by project authority);
- `public/host.html` — the partner "console": create a personal or conference chat in normal
  or translated mode, get join links, watch participants, end it for everyone;
- `public/join.html` — the end-user page: joins with a token through `@videofy/connect`,
  served as the **real built ESM bundle** aliased from `packages/connect-sdk/dist`
  (its one runtime dependency, `socket.io-client`, is mapped in with an import map).

The pages are plain on purpose: they demonstrate the SDK, not web craft.

## Run it

All commands from the repo root.

1. **Provision a Connect project** (the raw `vfk_` key prints exactly once — copy it):

   ```
   npm run connect:project:create -- --name sample --origin http://localhost:4173
   ```

2. **Start the gateway with Connect enabled.** Add to the repo-root `.env` (the gateway runs
   from `services/realtime-gateway`, so relative paths hop two levels up):

   ```
   CONNECT_AUTH_SECRET=any-string-of-at-least-32-characters-here
   CONNECT_PROJECTS_PATH=../../connect-projects.json
   ```

   then:

   ```
   npm run dev -w services/realtime-gateway
   ```

   (Environment variables work too, instead of `.env`.)

3. **Start this sample** with the key from step 1:

   POSIX shells:

   ```
   VIDEOFY_API_KEY=vfk_dev_... npm run dev -w examples/connect-sample
   ```

   PowerShell:

   ```
   $env:VIDEOFY_API_KEY = 'vfk_dev_...'; npm run dev -w examples/connect-sample
   ```

4. **Open <http://localhost:4173>**, create a video chat, then open its join link from two
   different browsers (or one normal plus one private window), pick different names, and join.

### Environment

| Variable              | Required | Default                 | Meaning                                            |
| --------------------- | -------- | ----------------------- | -------------------------------------------------- |
| `VIDEOFY_API_KEY`     | yes      | —                       | Project key; lives only in the sample server.      |
| `VIDEOFY_CONNECT_URL` | no       | `http://localhost:3001` | Videofy gateway origin (API and realtime).         |
| `PORT`                | no       | `4173`                  | Sample port; must match the provisioned `--origin` (the gateway authorizes browser joins by Origin). |

## What to look for

- **join.html** exercises the client SDK end to end: connection states, participant tiles with
  video via `attachVideo`, live captions, the per-listener audio-mode picker, mic/camera/leave,
  and an **Enable audio** button that appears on the SDK's `audioBlocked` event and invokes
  `enableAudio()` inside the click gesture.
- Join tokens are **single-use** with a short TTL; one that is spent (or dies with a gateway
  restart) surfaces as the terminal `needsNewJoinToken` event, and the page sends you back to
  the form to mint a fresh one — re-minting is the intended, cheap recovery.
- The sample server holds the only copy of the `vfk_` key, never logs it, and passes `/v1`
  error envelopes through to the pages with code, status, and requestId intact.

## Tests

```
npm test -w examples/connect-sample
```

- `src/__tests__/app.test.ts` proves the server half against a fake `/v1` injected through the
  server SDK's `fetch` seam: route wiring, envelope passthrough, local refusal with **zero**
  network traffic, subject handling, and that the key never appears in a response.
- `scripts/check-vocab.mjs` (also runs in `npm test`) scans every source file in this package
  and fails on any internal Videofy vocabulary — the sample must compile and run against the
  public SDK surfaces alone. The banned terms are assembled from pieces inside the script so it
  can name them without tripping itself.
