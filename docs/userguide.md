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

An event can also be written as a single line, a *complete event* with `ph: "X"`. Its `ts` is the begin and `dur` the duration, both in microseconds. TimeLens draws it the same way as a `B`/`E` pair:

```json
{"name": "Serialize", "ph": "X", "pid": 1027810, "tid": 1027810, "ts": 6383938378031, "dur": 1081 },
```

The browser keeps the last minute of events.

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

### PreTrigger

Sets how much time is shown **before** the trigger point, in milliseconds. A negative value such as `-10 ms` places the trigger 10 ms from the left edge of the graph.

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

### Measuring

- **Hover** over an event to see its duration, plus statistics of all events with the same name (see [Statistics](#statistics)).
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

- **Running:** the last minute, or the time since **SINGLE** was pressed if that is shorter. The statistics update about once per second. **Clear** does not reset them, because it only clears the browser and the server still has the events.
- **Stopped, panned or zoomed:** the range the running graph had at the moment it was frozen. They stay the same while you pan and zoom, so they match what you saw just before stopping.
- **After a SINGLE capture stops:** the captured range.

### Layout

Each graph panel can be resized. Remove a graph with the `x` in its corner.

## Profiles

A profile saves your graphs so you can get them back later. **Settings** in the top bar opens the profiles window.

A profile contains:

- the graphs, in their order on the screen,
- per graph: the trigger word, trigger edge, PreTrigger, View width and the panel size if you resized it,
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
