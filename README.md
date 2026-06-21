# Ren 恋

A literary relationship narrator with memory. Vanilla HTML/CSS/JS — no build step.

Ren reads a story moment, recalls related memories from **HydraDB**, narrates the
scene with an LLM, and writes the new narration back to memory. Three demo panels
trace one character's arc across time:

- **Moment 1 — The Ghosting**
- **Moment 3 — The Reveal**
- **Moment 4 — New Ghost, New Emily**

A live execution log shows every HydraDB read/write.

## Setup

1. Copy the config template and fill in your keys:
   ```sh
   cp config.example.js config.js
   ```
   Then edit `config.js` with your HydraDB and OpenAI keys.
   `config.js` is gitignored, so your keys never get committed.

2. Open `index.html` in a browser.

3. Click **Share with Ren** on Moment 1 first, so HydraDB has memories for
   Moments 3 and 4 to recall.

## Notes

- Keys live only in `config.js` (gitignored). Never hardcode keys into `index.html`.
- Narration uses the OpenAI Chat Completions API; memory uses HydraDB.
