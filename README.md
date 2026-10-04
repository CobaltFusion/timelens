<img alt="TimeLens" src="art/timelens_logo.png" />

TimeLens shows telemetry logs as signals on an oscilloscope-style timeline in the browser: every event is a bar from its begin to its end, you can trigger on an event, freeze the view, and measure timing.

This file describes what is implemented, and how each part is known to work. The [user guide](docs/userguide.md) explains how to use it.

# Key Features (Implemented!)

- 📈 Oscilloscope-style visualization of log data
  - Treats telemetry streams as signals over time
- 🔍 Zoomable & pannable timeline
  - Inspect milliseconds or hours of data with equal clarity
- 🧩 Multiple views
  - Compare different signals, subsystems, or metrics simultaneously
- ⚡ Server-side processing
  - Efficient handling of large or complex log datasets
- 🌐 Web-based interface
  - Lightweight client, accessible from any modern browser
- 🧠 Structured log interpretation
  - Works with semi-structured telemetry (timestamps, subprocesses, events, counters) (counters are not yet implemented)
- 📊 Event frequency/shape visualization (Working prototype)
  - Identify spikes, anomalies, and system behavior patterns

## What it does

- **Reads log files.** A Python server (FastAPI, uvicorn) watches a folder for `*.vson` files: one Chrome trace event per line. It pairs begin (`B`) and end (`E`) events, and complete events (`X`), into spans, and reads the names of processes and threads from the metadata lines (`M`).
- **Shows them live.** The browser gets the spans over a WebSocket and draws them on graphs: one row per thread, named `process / thread`. Hovering over an event shows its duration, its pid and tid with their names, and statistics of all events with the same name. An event that has not ended yet grows, drawn at half its estimated length.
- **Triggers like an oscilloscope.** Trigger on an event name (with wildcards), on its begin or its end, and on its duration (longer or shorter than a limit). Pre-trigger, view width, auto, single, stop and run, and panning and zooming.
- **Filters and profiles.** Include, exclude and color rules, applied by the server. The graphs and filters are saved as named profiles on the server, and the `default` profile is loaded when the page opens.
- **Finds other servers.** The server list shows the TimeLens servers on the network, and the speed test measures latency and bandwidth from the browser to each of them: one test, or running until stopped with the average of the last 20 seconds, and a guess of the speed of the network connection.
- **Summarizes on the command line.** `python -m timelens.summary` reads the whole log files once and prints statistics per name, pid and tid.

## Run it

1. Put `*.vson` files in `/tmp/logs/telemetry`, or in `c:/temp/logs/telemetry` when that folder does not exist. On Windows, `python tests/python/add_event.py` writes test events there.
2. Windows: run `start_timelens.bat`. It makes a virtual environment (Python 3.13), installs the dependencies, and opens http://localhost:8080. Linux: `start_timelens.sh`, not verified.
3. Tools: `python validate.py` runs all checks, `python -m timelens.summary` prints the summary (run it with the virtual environment of the project). Node is only needed for ESLint, the TypeScript check and `obfuscate.bat`.

A log line looks like this (the file is a JSON array that is never closed, every event ends with a comma):

```json
{ "name": "Serialize", "ph": "B", "pid": 1027810, "tid": 1027810, "ts": 6383938378031 },
{ "name": "Serialize", "ph": "E", "pid": 1027810, "tid": 1027810, "ts": 6383938379112 },
```

## Limits

- Only `B`, `E`, `X` and `M` events are used. Events of other phases, like counters (`C`) and instants (`i`), are ignored.
- For a big file the server only reads the last 30 minutes, plus the metadata lines at the start. The command line summary reads everything.
- The browser keeps the last minute of events, the server the last 30 minutes, in memory. The server has no data of its own: after a restart it reads the files again.
- On Windows the server keeps the log files open, so they cannot be deleted while it runs.
- Tested in Edge, Brave, on Windows 11, iPad and Android Phone.

## User Documenation

- The [User guide](docs/userguide.md): every control, the file format, profiles, filters, the speed test.

