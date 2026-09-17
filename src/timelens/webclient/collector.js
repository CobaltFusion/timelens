/**
 * @typedef {"open" | "close" | "duration" | "value"} EventType
 */

const EventType = {
    OPEN: "open",           // only has timestamp
    CLOSE: "close",         // has both timestamp and end_time
    DURATION: "duration",   // has both timestamp and end_time
    VALUE: "value"          // has timestamp + value
};

const audio = new AudioContext();

function beep(frequency, startTime, duration, type = "sine") {
    const osc = audio.createOscillator();
    const gain = audio.createGain();

    osc.type = type;
    osc.frequency.value = frequency;

    gain.gain.value = 0.2;

    osc.connect(gain);
    gain.connect(audio.destination);

    osc.start(audio.currentTime + startTime);
    osc.stop(audio.currentTime + startTime + duration);
}

function randomNote(startTime = 0) {
    const types = ["sine", "square", "sawtooth", "triangle"];
    const notes = [
        261.63, 277.18, 293.66, 311.13,
        329.63, 349.23, 369.99, 392.00,
        415.30, 440.00, 466.16, 493.88,
        523.25, 554.37, 587.33, 622.25,
        659.25, 698.46, 739.99, 783.99,
        830.61, 880.00, 932.33, 987.77
    ];

    const duration = 0.02 + Math.random() * 0.08;

    beep(
        notes[Math.floor(Math.random() * notes.length)],
        startTime,
        duration,
        types[Math.floor(Math.random() * types.length)]
    );

    return duration;
}

/**
 * @typedef {Object} TSEvent
 * @property {string} name
 * @property {string} type
 * @property {number} timestamp
 * @property {number} groupId
 * @property {number} value
 */

/**
 * @param {string} name
 * @param {string} type
 * @param {number} timestamp
 * @param {number} groupId
 * @param {number} value
 * @returns {TSEvent}
 */
function makeEvent(name, type, timestamp, groupId, value) {
    //console.log("make: %s, type: %s, ts: %s ", name, type, timestamp);

    return {
        name: name,
        type: type,
        timestamp: timestamp,     // microseconds (us)
        groupId: groupId,
        value: value
    };
}

function containsIgnoreCase(text, search) {
    return text.toLowerCase().includes(search.toLowerCase());
}

/**
 * A Collector for events received in Chrome JSON trace format.
 *
 * Incoming WebSocket messages are expected to contain Chrome JSON trace-style event
 * fields:
 *   name, cat, ph, pid, tid, ts
 *
 * All timestamps (`ts` and `te`) are in microseconds (�s).
 * They represent time elapsed since the start of the source process.
 *
 * For complete events:
 *   ph != 'E'  -> `ts` is the event start time.
 *
 * For end events:
 *   ph == 'E'  -> the incoming `ts` is interpreted as the end time (`te`),
 *                 and `ts` is set to zero because `makeEvent()` represents
 *                 the event as an open/close pair.
 *
 * The `tid` field is used as the group ID, so events from the same
 * thread are displayed on the same graph line.
 */
class Collector {
    constructor() {
        /** @type {TSEvent[]} */
        this.incoming = []; // this an array of structs, if GC becomes a problem, we should turn this into a struct of arrays for zero-reallocation
        this.running = true;
        this.audioEnabled = false;
        this.cutoffTime = 0;  // event from before this time are dropped
        this.triggerWord = "";
        this.millisecondsPerGraphWidth = 1000;
        this.millisecondOffset = -10;
        this.lastTimepoint = 0;
        this.onConnectionLost = null;

        this.setAudio();

        // this uses the 'host' where we are loading this application from
        const wsUrl = `ws://${window.location.host}/ws`;
        this.ws = new WebSocket(wsUrl);
        console.log("Collector connecting to", wsUrl);

        this.ws.onclose = () => {
            console.error("Connection to server closed!");
            this.onConnectionLost?.();
        };

        this.ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            // notice that the variables MUST correspond with the actual JSON field names here!
            const { name, cat, ph, pid, tid, ts } = data;

            if (this.lastTimepoint > 0 && ts < this.lastTimepoint) {
                console.warn(`Out of order event; ts: ${ts}: ${name} `)
                return
            }

            this.lastTimepoint = Math.max(ts, this.lastTimepoint);
            //console.log("I: ", data);

            const type = ph === "E" ? EventType.CLOSE : EventType.OPEN;

            // beeping
            if (type === EventType.OPEN) {
                if (containsIgnoreCase(name, "error")) {
                    console.log("Error beeping");
                    beep(1300, 0, 0.03, "square");
                }
                if (containsIgnoreCase(name, "message")) {
                    console.log("Message beeping");
                    beep(800, 0, 0.05);
                }
            }
            const groupId = tid; // use tid as grouping for single line
            const value = 0;
            this.incoming.push(makeEvent(name, type, ts, groupId, value));

            const minute = 60 * 1e6; // us
            this.cutoffTime = this.lastTimepoint - minute; // keep last minute
            this.trimIncomingData(this.cutoffTime);
        };
    }

    clear() {
        // this clears the elements, incoming[0]  // undefined
        // but does not release the underlying storage, so its efficient and GC friendly
        this.incoming.length = 0;
    }

    data() {
        return this.incoming; // returns a reference, not a copy
    }

    setTriggerWord(triggerWord) {
        this.triggerWord = String(triggerWord);
    }

    getTriggerWord() {
        return this.triggerWord;
    }

    setMillisecondsPerGraphWidth(milliseconds) {
        const value = Number(milliseconds);

        if (Number.isFinite(value) && value > 0) {
            this.millisecondsPerGraphWidth = value;
        }
    }

    setOffset(milliseconds) {
        this.millisecondOffset = milliseconds;
    }

    getMillisecondsPerGraphWidth() {
        return this.millisecondsPerGraphWidth;
    }

    getOffset() {
        return this.millisecondOffset;
    }

    getLastTimepoint() {
        return this.lastTimepoint;
    }

    stop() {
        this.running = false;
        // stop receiving more data.
    }

    start() {
        this.running = true;
        // re-start receiving data
    }

    reset() {
        this.lastTimepoint = 0;
        this.clear();

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("Cannot reset: WebSocket is not connected");
        }

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "control", action: "reset" }));
        }
    }

    setAudio() {
        if (this.audioEnabled) {
            audio.resume();
        } else {
            audio.suspend();
        }
    }

    async toggleAudio() {
        this.audioEnabled = !this.audioEnabled;
        this.setAudio();
        return this.audioEnabled;
    }

    isAudioEnabled() {
        return this.audioEnabled;
    }

    asTime(msTime) {
        return this.cutoffTime + (msTime * 1000);
    }

    dummy() {
        this.setAudio();
        this.incoming.push(makeEvent("capture_image", EventType.DURATION, this.asTime(10), this.asTime(100), 0, 0));
        this.incoming.push(makeEvent("process_image", EventType.OPEN, this.asTime(13), 0, 0, 0));
        this.incoming.push(makeEvent("set_outputs", EventType.DURATION, this.asTime(15), this.asTime(40), 0, 0));
        this.incoming.push(makeEvent("process_image", EventType.CLOSE, this.asTime(0), this.asTime(20), 0, 0)); // intentionally out-of-order
        //this.incoming.push(makeEvent("cycle", EventType.CLOSE, this.asTime(0), this.asTime(500), 0 ,0)); // intentionally omitted

        beep(1300, 0.0, 0.05, "square");

        // let t = 0;
        // for (let i = 0; i < 20; ++i) {
        //     const duration = randomNote(t); // randomNote returns its duration
        //     t += duration;
        // }
    }

    // this function is approximately O(n), still data is copied, so its not ideal.
    trimIncomingData(cutoffTime) {
        const index = this.incoming.findIndex(event => event.timestamp >= cutoffTime);

        if (index < 0) {
            this.incoming.length = 0;
            return;
        }
        // starting at array index 0, remove index elements.
        this.incoming.splice(0, index);
    }
}
