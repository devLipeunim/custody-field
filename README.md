# Custody Field App

Evidence collection at the scene. Fingerprints a file on the device before it is handled by
anyone else, queues the record locally, and syncs when a connection becomes available.

Part of **Custody**, ICSC 2026 Universities Hackathon, Track H, by Team Echelon.
The API and the project overview are in [`hackathonBackend`](../hackathonBackend).

---

## Contents

- [Overview](#overview)
- [Tech stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Project structure](#project-structure)
- [Implementation notes](#implementation-notes)

---

## Overview

Collection is entirely local. The officer taps once, the file is fingerprinted on the device,
and the record is written to SQLite. No network call sits on that path, because at a scene
there may be no network for hours. Sync is a separate, deferred, interruptible activity.

That ordering is the point: the fingerprint exists before the file has been anywhere, so
nothing between the scene and the server can alter it undetectably.

---

## Tech stack

| Layer | Choice |
| --- | --- |
| Framework | React Native 0.86, Expo SDK 57 |
| Hashing | `expo-crypto` (SHA-256) |
| File access | `expo-file-system` (seekable handles) |
| Local storage | `expo-sqlite` |
| Capture | `expo-document-picker`, `expo-image-picker` |
| Location | `expo-location` (optional) |

No animation library: motion uses React Native's built in `Animated`.

---

## Prerequisites

- Node.js 20 or later
- The Custody API running and reachable on the same network
- Expo Go, or a simulator

---

## Getting started

```bash
npm install
npx expo start
```

Open on a device or simulator, then tap **Setup** to configure the officer badge and case reference. (To point to a local backend, update `serverUrl` in `DEFAULTS` inside `App.js`).

---

## Configuration

Set in the app under **Setup**, and persisted to SQLite.

| Setting | Example | Notes |
| --- | --- | --- |
| Officer badge | `NPF-22841` | Must exist on the server |
| Case reference | `CID-2026-0041` | Must exist on the server |

The server address is not a setting. It ships with the build, as `serverUrl` in `DEFAULTS` in
`App.js`, and a stored value never overrides it. To sync to a local backend, change it there and
rebuild: use the machine's LAN address, such as `http://192.168.1.24:4000`, never `localhost`,
which on a handset resolves to the handset. The API prints its LAN address on startup.

---

## How it works

### Collection

1. Pick a file.
2. Hash it on device in 4MB chunks, with progress shown per chunk.
3. Build a Merkle root over the chunk hashes.
4. Capture collector, device time and, if available, GPS.
5. Write the sealed record and queue a `collected` event in SQLite.
6. Display the short fingerprint and a **Sealed, not synced** badge.

Steps 1 to 6 require no network. GPS is optional and never blocks sealing.

### Sync

Batched, retried and automatic once the server becomes reachable. Each item shows exactly one
of **Sealed, not synced**, **Synced** or **Sync failed**, and the header carries a count of
everything outstanding.

The evidence file is never uploaded. Only the root hash, the ordered chunk hashes and metadata
travel, which avoids request size limits and mirrors evidence handling, where the exhibit and
the paperwork move separately.

### Reachability

The status indicator polls `/api/health`, the same request a sync would make, so it reflects
actual reachability rather than a connectivity API's opinion.

---

## Project structure

```
App.js              screens, collection flow, sync orchestration
src/
  hash.js           chunked hashing and the Merkle tree
  chain.js          device side event hashing
  db.js             SQLite queue
  api.js            sync client
  payload.js        pure sync payload builder
  ui.js             motion and loading states
```

---

## Implementation notes

**Parity with the server is mandatory.** Both sides must produce identical fingerprints or
nothing verifies. Two rules hold them in step:

1. A chunk hash is SHA-256 over the chunk's **raw bytes**.
2. Every other hash is SHA-256 over a UTF-8 **string of hex digits**.

`hackathonBackend/test/device-parity.test.mjs` asserts this against the server implementation,
including tree shape at 1, 2, 3, 5, 7, 8 and 9 chunks.

**Constant memory.** `expo-file-system`'s `File.open()` returns a handle with a seekable
`offset`, so chunks are read one at a time with `readBytes()` and the whole file is never held
in memory. `readAsStringAsync` is deprecated in SDK 57 and is not used.

**The device does not sign its own events.** It computes a provisional event hash so a sealed
state can be shown offline, but does not send it: it cannot know the server's item and actor
identifiers before the item exists there, so any hash it computed would be over different
inputs. The server recomputes on arrival and its result is the record.

**`storagePath` is sent as null.** The handset holds the file at a private URI and knows
nothing of the evidence store's layout. The path is recorded separately on deposit. A guess
here would make an undeposited item indistinguishable from a deleted one.

**`src/payload.js` is deliberately free of SQLite and `fetch`,** so the backend's test suite
imports the real module and asserts its output against the live API rather than testing a copy
that could drift.

**Motion** is confined to hashing progress, a newly sealed item arriving, and the pending
count. The system reduce motion setting is honoured.

All data used in demonstration is synthetic. See the backend README for provenance.
