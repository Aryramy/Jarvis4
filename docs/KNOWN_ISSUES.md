# Known Issues

Currently tracked issues in JARVIS4:

1. **Windows Node.js Runtime Version for Live Network Calls**:
   - On this Windows machine, live external provider calls should use portable Node.js `v24.21.0` (or newer).
   - An upstream Windows/libuv socket shutdown assertion was observed on Node.js `v24.19.0` after a successful HTTP fetch. The exact same application code executes and terminates cleanly with exit code 0 under portable Node.js `v24.21.0`.
