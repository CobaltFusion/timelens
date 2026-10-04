# TimeLens User Guide

TimeLens shows telemetry events as signals on an oscilloscope-style timeline. Each event is drawn as a bar from its begin to its end, and you can trigger on an event, freeze the view, zoom in and measure timing, much like on a real oscilloscope.

## Starting TimeLens

- **Windows:** run `start_timelens.bat`. On the first run it creates a Python virtual environment and installs the dependencies. It then opens http://localhost:8080 in your browser.
- **Linux:** run `start_timelens.sh` and open http://localhost:8080 yourself.

Run `start_timelens.bat reinstall` to rebuild the virtual environment from scratch.

## Where the data comes from

The server watches a folder for `*.vson` files and streams every new line to the browser:

- `/tmp/logs/telemetry` if that folder exists,
- otherwise `c:/temp/logs/telemetry`.

Each line is a JSON event in the Chrome trace format. TimeLens uses `ph: "B"` as the begin of an event and `ph: "E"` as its end. The events are grouped into rows by `tid`.

```json
{"name": "Serialize", "ph": "B", "pid": 1027810, "tid": 1027810, "ts": 6383938378031 },
{"name": "Serialize", "ph": "E", "pid": 1027810, "tid": 1027810, "ts": 6383938379112 },
```

Only the phases `B`, `E` and `X` (below) are events for TimeLens, and `M` (metadata, see [Names of processes and threads](#names-of-processes-and-threads)). Lines with another phase, like counters (`"ph": "C"`) and instants (`"ph": "i"`), are ignored: they are not drawn, do not trigger and are not counted in the statistics.

An event can also be written as a single line, a *complete event* with `ph: "X"`. Its `ts` is the begin and `dur` the duration, both in microseconds. TimeLens draws it the same way as a `B`/`E` pair:

```json
{"name": "Serialize", "ph": "X", "pid": 1027810, "tid": 1027810, "ts": 6383938378031, "dur": 1081 },
```

The browser keeps the last minute of events.

### Names of processes and threads

A line with `"ph": "M"` (or `"cat": "__metadata"`) is not an event: it gives a name to a process or a thread. `process_name` names the `pid` and `thread_name` names the `tid`, in `args.name`:

```json
{ "args": {"name": "pylon_gevmgr"}, "name": "process_name", "cat": "__metadata", "ph": "M", "pid": 1028534, "tid": 0, "ts": 0 },
{ "args": {"name": "worker 1"}, "name": "thread_name", "cat": "__metadata", "ph": "M", "pid": 1028534, "tid": 7, "ts": 0 },
```

The names are shown behind the pid and tid in the hover of an event, for example `pid: 1028534 (pylon_gevmgr)` and `tid: 7 (worker 1)`. They are not drawn as events and not counted in the statistics. A thread name belongs to the pid and tid together, a process name to the pid in all files. If a name is given again, the last one is used, and other kinds of metadata (like `process_sort_index`) are ignored.

A program writes its names at the start of its file. For a very large file the server only reads the end, but it also reads the metadata lines at the start of the file (up to the first line that is an event), so the names are not lost. A name that is written later in a large file, before the part that is read, is not found.

## The top bar

| Control | What it does |
|---|---|
| **Add Graph** | Adds another graph panel. Each graph has its own trigger and view settings. |
| **Settings** | Saves the graphs and their settings as a profile on the server, or loads one. See [Profiles](#profiles). |
| **Reset** | Asks the server to replay the last 10 minutes of recorded data. |
| **Clear** | Removes all received events, including the snapshots held by stopped graphs. |
| Speaker icon | Turns audio alerts on or off. |
| **Signature** | Plays all incoming events as one continuous sound, so unusual events stand out (key: `g`). |
| Connected / Disconnected | Shows whether the browser is connected to the server. |
| Traffic indicator | Flashes when events arrive. |
| Health indicator | Shows recent event durations. Click it to switch to the *message signature* view, where events that arrive at an unusual interval are marked in red. |

With audio on, events whose name contains `error` or `message` produce a short beep.

## Graph controls

Each graph has a row of controls above it.

### Trigger word

Type part of an event name to trigger on it. Matching is case-insensitive, and `*` matches any text, so `proc*image` matches `process_image`. When the field is empty, the graph runs freely and shows the most recent data.

### Trigger edge (rising / falling)

The button with the edge symbol, next to the trigger word, chooses **which moment of the event** TimeLens triggers on. Click it to switch:

- **Rising edge** (default): triggers on the **beginning** of the event (its `B` line).
- **Falling edge**: triggers on the **end** of the event (its `E` line).

Use the falling edge when you are interested in what happens *after* an event finishes, for example the work that starts when a long `process_image` completes. Complete events (`ph: "X"`) work on both edges as well: the rising edge is their `ts`, the falling edge is `ts + dur`.

Changing the edge starts the search for a trigger over again, in Auto mode.

### Trigger duration

The **Duration** controls, next to the edge button, limit the trigger to events of a certain length: click the comparison button to cycle through `any`, `<` (shorter than) and `>` (longer than), type a number, and click the unit button to cycle through `us`, `ms` and `s`. Like the edge button, they show the current choice and move to the next one when clicked. For example, trigger word `test` with `< 100 us` triggers only on `test` events that took less than 100 microseconds, and `name` with `> 5 ms` only on `name` events longer than 5 milliseconds. With `any`, the default, events trigger whatever their duration and the number is disabled; it keeps its value, so it is still there when you switch back to `<` or `>`. A `<` or `>` with an empty number also means any duration.

Things to know:

- The duration of an event is only known when it has ended, so a trigger with a duration waits for the event to finish. An event that is still open never triggers.
- The trigger point is still the edge you chose: the **begin** of the matching event with the rising edge, its **end** with the falling edge. The graph is shown around that point, so with the rising edge it looks back to the start of the long (or short) event.
- Events of exactly the given duration do not match, `>` and `<` are strict.
- Changing the duration starts the search for a trigger over again, in Auto mode.

### PreTrigger

Sets how much time is shown **before** the trigger point, in milliseconds. A negative value such as `-10 ms` places the trigger 10 ms from the left edge of the graph. It also works on a stopped graph: the zero point and the right edge stay where they are and the left edge moves, so the view gets longer or shorter.

### View

Sets the width of the graph in milliseconds. **AutoSet** chooses a width based on the longest event in the buffer.

### AUTO, STOP/RUN and SINGLE

- **AUTO**: keeps following the most recent trigger.
- **STOP/RUN**: freezes the graph on its current data, or resumes it.
- **SINGLE**: waits for the *next* trigger, keeps recording for 10 seconds after it, then stops. The status label fills up while it records.

The status label next to these buttons shows `Auto`, `Wait` (no trigger found yet) or `Triggered`.

## Exploring a graph

Click a graph to select it. The keyboard shortcuts act on the selected graph:

| Key | Action |
|---|---|
| `a` / `d` | Pan left / right |
| `w` / `s` | Zoom in / out |
| `q` | Leave the panned/zoomed view and follow live data again |
| `g` | Toggle the signature sound |

Panning or zooming freezes the graph on its current data until you press `q` or **RUN**.

On a touch screen, drag to pan and pinch to zoom.

### Rows and their names

Every thread (`tid`) has a row in the graph, and events of the same thread that overlap are drawn under each other in that row. The column left of the graph names the row: `process / thread`, with the names that the log files give with their [metadata lines](#names-of-processes-and-threads). Without a name the pid or tid is shown instead, for example `pylon_gevmgr / 1029844`. When a label does not fit in the column, the process name is shortened first, so the thread name stays readable. A row that is cut off at the bottom of the graph keeps its label in the part that is visible.

The column is 160 pixels wide and is left out when the graph is narrower than about 420 pixels, to leave room for the graph itself.

### Events that have not ended

An event that has begun but has not ended yet grows in the graph, with a fading end. Its length is estimated from the time of the last event that arrived plus the time that has passed since, and the bar is drawn only **half** as long as that estimate. The end of an event can arrive late, and a bar that is drawn too long would shrink when it does. When the end arrives, the bar gets its real length. The hover of an event that is still open shows the full estimate and `(open)`.

An event that has been open for a long time is therefore drawn only up to half of the time it has been open, so one that has been open for more than twice the width of the graph is no longer in the view.

### Measuring

- **Hover** over an event to see its duration, plus statistics of all events with the same name (see [Statistics](#statistics)). The statistics are the last lines of the hover. When the graph is too short for all the lines (less than about 200 pixels), the statistics are shown in a second column next to the other lines, so they are not cut off.
- **Drag** across the graph to measure the time between two points.
- Hold **Shift** while dragging to snap the cursor to the begin or end of the event under the mouse.

### Statistics

The hover tooltip shows duration statistics for the name of the event under the mouse:

| Line | Meaning |
|---|---|
| `samples` | How many events with this name were counted |
| `min` / `max` | The shortest and longest duration |
| `avg` | The average duration |
| `stddev` | The sample standard deviation of the durations, `-` when there is only one sample |

How they are counted:

- Events are matched on their exact name, across all rows (`tid`s) and all log files.
- Only completed events count. An event that is still open is not included until its end arrives.
- An event counts when it **begins** inside the data range of the graph. Its duration is its end minus its begin.
- The server calculates the statistics, so they cover all events it has, not only what the graph shows.

The data range depends on the state of the graph:

- **Running:** from the oldest event that the graph holds, which is about the last minute, or the time since **SINGLE** was pressed if that is shorter. It starts at the events that the graph holds, and not at a minute before the newest event of all: log files can have different clocks, and a view that is triggered on events of one clock then still has statistics of those events. The statistics update about once per second. **Clear** does not reset them, because it only clears the browser and the server still has the events.
- **Stopped, panned or zoomed:** the range the running graph had at the moment it was frozen. They stay the same while you pan and zoom, so they match what you saw just before stopping.
- **After a SINGLE capture stops:** the captured range.

### Layout

Each graph panel can be resized. Remove a graph with the `x` in its corner.

## Profiles

A profile saves your graphs so you can get them back later. **Settings** in the top bar opens the profiles window.

A profile contains:

- the graphs, in their order on the screen,
- per graph: the trigger word, trigger edge, trigger duration, PreTrigger, View width and the panel size if you resized it,
- the [filters](#filters).

It does not contain audio, the signature sound, the health indicator mode, or whether a graph is running or stopped.

In the profiles window:

| Button | What it does |
|---|---|
| **Load** | Replaces all graphs and filters with those of the selected profile. You can also double-click a profile. |
| **Save** | Saves the current graphs and filters under the typed name. Asks first if the profile already exists. |
| **Save as default** | Saves the current graphs as the `default` profile. |
| **Delete** | Deletes the selected profile. |

The `default` profile is loaded automatically when TimeLens is opened. Without it, TimeLens starts with one empty graph. The `default` profile only changes when you save to it, so changes you make during a session are not kept unless you save them.

Profiles are stored by the server, so every browser that connects to it sees the same profiles. They are JSON files in `~/.timelens/profiles/`, in the home directory of the user that runs the server. A profile name can contain letters, digits, spaces, `_`, `.` and `-`.

## Filters

Filters choose which events you see, and can give events a fixed color. They are edited in the **Settings** window, below the profiles. The server applies them, so a filtered event never reaches the browser: it is not drawn, it does not trigger, it is not counted in the [statistics](#statistics) and it does not beep.

Each rule is one row:

| Control | Choices |
|---|---|
| Field | What the pattern is matched against: the event **name** (default), **category** (`cat`), **source** (the log file name), **pid** or **tid**. |
| Pattern | The text to match. A row with an empty pattern is ignored. |
| Match | **normal**: like the trigger word, case-insensitive, `*` matches any text, and without `*` the pattern matches anywhere. **regex**: a case-insensitive regular expression that can match anywhere, use `^` and `$` to anchor it. |
| Type | **include**, **exclude** or **color**. |
| Color | Only shown for color rules: the color of matching events. |

How the rules combine:

- **Include** rules are combined with OR: an event is shown when it matches any of them. Without include rules, all events are shown.
- An **exclude** rule wins over all include rules: a matching event is never shown.
- The first matching **color** rule sets the color of an event. Color rules do not change which events are shown.

For example, these rules show only the events of `pylon_gevmgr` and those with `error` in their name, hide the `heartbeat` events, and draw timeouts in red:

| Field | Pattern | Match | Type |
|---|---|---|---|
| source | `pylon_gevmgr` | normal | include |
| name | `error` | normal | include |
| name | `heartbeat` | normal | exclude |
| name | `timeout$` | regex | color (red) |

Press **Apply filters** to send the rules to the server. The graphs are then filled again with the filtered events, including stopped graphs. When a rule is invalid, for example a regular expression with an error, the window says which rule is wrong and the previous filters stay active. **Remove all** removes every rule and applies that right away, so all events are shown again.

The filters are part of the profile. **Save** and **Save as default** apply the filters first, so a profile always holds the filters you see. Loading a profile replaces the filters; a profile without filters shows all events.

## Command line summary

`python -m timelens.summary` prints a statistical summary of the events in the log files, without the server or a browser. It reads the same files as the server (the folder in [Where the data comes from](#where-the-data-comes-from)) but reads each file **once, entirely**, where the server only reads the last 30 minutes of a file. Run it from the project folder with the virtual environment of the project, for example `venv\Scripts\python -m timelens.summary`.

The events are paired into spans as in the graphs: a begin (`B`) with its end (`E`), or a complete event (`X`). The spans are grouped by the combination of **name, pid and tid**, and for every group the table shows:

| Column | Meaning |
|---|---|
| `count` | How many spans the group has |
| `total` | The sum of their durations |
| `min`, `mean`, `max` | The shortest, average and longest duration |
| `p50`, `p95`, `p99` | Percentiles of the durations: half, 95% and 99% of the spans are shorter than this |
| `stddev` | The sample standard deviation, `-` for a single span |
| `open` | Begins that have no end, for example from an event that was still running when the file ended |

```
python -m timelens.summary [path ...] [--name PATTERN] [--sort total|count|mean|max|name] [--top N]
                           [--format table|csv|json] [--no-percentiles] [--quiet]
```

- **path:** one or more `*.vson` files, or folders with them. Without a path the folder of the server is used.
- **--name:** only groups whose name matches, with the wildcards of the trigger word (case-insensitive, `*` matches any text).
- **--sort, --top:** the biggest first, by the total time by default, and optionally only the first N groups.
- **--format:** `csv` and `json` give the durations in microseconds, to use in a spreadsheet or a script. The totals line then goes to the error output, so the data stays clean.
- **--no-percentiles:** the percentiles need 8 bytes of memory per event, a file with hundreds of millions of events does not fit in memory with them.

Metadata lines (names of processes and threads) are not events and are left out. A line that is not a JSON object is skipped and counted below the table, as are events without a time, events of another phase than `B`, `E` and `X`, and end events without a begin. A file is read at about 20 MB per second, a percentage shows while it is read.

## Speed test

The speed test measures the **latency** and the **bandwidth** between this browser and a TimeLens server, for example to see whether the network is good enough to follow a server on another machine.

The page (`speedtest.html`) lists **all** the servers that were discovered. **Speed test** at the end of a server's row in the server list (`index.html`) opens the page with that server highlighted (`speedtest.html?server=address:port`), so you can test it right away with its own **Test** button. If that server was not discovered, it is added to the table, so it can be tested too.

Nothing is sent until you press a button: **Test all** starts every server in the table at the same time, **Test** on a row starts that server alone, and **Stop** (or **Stop** on a row) ends the tests that are running. A server that cannot be reached shows `no answer from the server` and does not stop the others.

For every server the table shows:

| Column | Meaning |
|---|---|
| Latency **min**, **avg**, **max** | The shortest, average and longest round trip, in milliseconds, of small requests that are made one after the other. A test makes 20 of them, and a first request that opens the connection is not counted. |
| **Download** | MB/s from the server to this browser. |
| **Upload** | MB/s from this browser to the server. |
| **Line speed (guess)** | A guess of the speed of the network connection, and how much of it the download and the upload use. See below. |

A megabyte (MB) is 1024 × 1024 bytes, so 100 MB/s is a little more than 800 megabit/s.

### One test

A server is measured in three steps, one after the other, so they do not disturb each other: the latency, then the download, then the upload. The download and the upload start with 1 MB, and the next ones are sized from the speed of the one before, until one takes about one and a half seconds. The speed of that last one is shown. A request is never more than 256 MB, so on a very fast network that is the most that is sent. On a fast network, a test sends hundreds of megabytes in each direction.

### Keep running until Stop

With **Keep running until Stop** ticked, **Test** and **Test all** do not stop after one round: they go on, round after round, until you press **Stop**. A round is five round trips while the line is quiet, then a download of about a second, then an upload of about a second. The table shows the **average of the last 20 seconds**, so you see the speed and the latency change when something else uses the connection, and an old measurement goes out of the average after 20 seconds. The status shows how much of the 20 seconds has been measured yet (`running, average of the last 14 s`). A speed is the bytes of all the runs in the last 20 seconds divided by the time of all those runs. The latency min, avg and max are those of the round trips in the last 20 seconds. After **Stop** the last values stay in the table. The box can only be changed while nothing runs.

### Line speed (guess)

From the best speed that was measured, the page guesses the speed of the network connection: **10 Mbps**, **100 Mbps**, **1 Gbps**, **2.5 Gbps**, **5 Gbps** or **10 Gbps**. It takes the slowest of these that can carry the best of the download and the upload speed. A line cannot carry data at its full speed, because the headers of TCP, IP and Ethernet take about 5%, so a line carries at most 94.9% of its speed as data: about 113 MB/s for 1 Gbps, 11.3 MB/s for 100 Mbps. A speed above that of 10 Gbps is shown as `> 10 Gbps`: the server is probably on the computer of the browser, where the data does not go through a network.

Under the guess are the percentages of the download and the upload, **of the speed of the line**: with the guess `1 Gbps`, a download of 100 MB/s shows `down 84%`, because 100 MB/s is 839 Mbit/s of 1000 Mbit/s. Hover over it to see the speed that the guess is made from and the highest MB/s of that line. While a test keeps running, the guess is made from the best average of the last 20 seconds that was measured, and the percentages are of the current averages.

It is a guess. The best speed can be low for another reason than the line: a slow computer or server (the server of TimeLens itself delivers about 260 MB/s), other traffic on the connection, or servers that are tested at the same time and share it. The line then looks slower than it is. The page can only see how much was carried, not how much the line could carry: when the best speed is 50 MB/s (419 Mbit/s) on a line of 10 Gbps, the guess is 1 Gbps. Test one server at a time for the best guess.

### Several servers

Servers that are tested at the same time share the connection of this computer, so each of them shows less than it would alone: to measure the maximum speed to a server, test that server alone. The latency of the servers that run together can also be a little higher, for the same reason.

The test is between **this browser** and the server: the page asks the server directly, also when the server is on another machine, and not through the server that served the page.
