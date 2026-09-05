const EventType = {
    OPEN: "open",           // only has a valid begin_time
    CLOSE: "close",         // only has a valid end_time
    DURATION: "duration",   // both begin_time + end_time are valid
    VALUE: "value"          // has a valid begin_time + value
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

function makeEvent(name, type, begin_time, end_time, groupId, value) {
    //console.log("make: %s, type: %s, b: %s, e: %s ", name, type, begin_time, end_time);

    return {
        name: name,
        type: type,
        begin_time: begin_time,
        end_time: end_time,
        groupId: groupId,
        value: value
    };
}

function containsIgnoreCase(text, search) {
    return text.toLowerCase().includes(search.toLowerCase());
}

class Collector {
    constructor() {
        this.incoming = []; // this an array of structs, if GC becomes a problem, we should turn this into a struct of arrays for zero-reallocation
        this.running = true;

        // this uses the 'host' where we are loading this application from
        const wsUrl = `ws://${window.location.host}/ws`;
        this.ws = new WebSocket(wsUrl);
        //this.ws = new WebSocket(`ws://172.16.2.17:8080/ws`);

        console.log("Collector connecting to", wsUrl);
        this.ws.onmessage = (event) => {

            const data = JSON.parse(event.data);
            // notice that the variables MUST correspond with the actual JSON field names here!
            let te = 0;
            let { name, cat, ph, pid, tid, ts } = data;

            const value = 0;
            let type = EventType.OPEN;
            if (ph === 'E') {
                type = EventType.CLOSE;
                te = ts;
                ts = 0;
            }
            const groupId = tid; // use tid as grouping for single line
            this.incoming.push(makeEvent(name, type, ts, te, groupId, value));

            if (te === 0 && containsIgnoreCase(name, "error")) {
                console.log("Error beeping");
                beep(1300, 0, 0.03, "square");
            }
            if (te === 0 && containsIgnoreCase(name, "message")) {
                console.log("Message beeping");
                beep(800, 0, 0.05);
            }
        }
    }

    clear() {
        console.log("clear");
        // this clears the elements, incoming[0]  // undefined
        // but does not release the underlying storage, so its efficient and GC friendly
        this.incoming.length = 0;
    }

    data() {
        return this.incoming; // returns a reference, not a copy
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
        this.clear();

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "control", action: "reset" }));
        }
    }

    async toggleAudio() {
        if (audio.state === "running") {
            await audio.suspend();
        } else {
            await audio.resume();
        }
        return audio.state;
    }

    audioState() {
        return audio.state;
    }

    dummy() {

        this.incoming.push(makeEvent("cycle", EventType.OPEN, 0, 0, "groupid"));
        this.incoming.push(makeEvent("capture_image", EventType.DURATION, 10 * 1000, 230 * 1000, "groupid"));

        this.incoming.push(makeEvent("process_image", EventType.OPEN, 231 * 1000, 0, "groupid"));
        this.incoming.push(makeEvent("set_outputs", EventType.DURATION, 310 * 1000, 400 * 1000, "groupid"));
        this.incoming.push(makeEvent("process_image", EventType.CLOSE, 0, 300 * 1000, "groupid")); // intentionally out-of-order
        //this.incoming.push(makeEvent("cycle", EventType.CLOSE, 0, 500*1000, "groupid")); // intentionally omitted

        beep(500, 0, 0.1);
        beep(600, 0.1, 0.6);
        beep(700, 0.7, 0.4);
        beep(500, 1.1, 0.1);
        beep(600, 1.2, 0.5);

        let t = 0;
        for (let i = 0; i < 20; ++i) {
            const duration = randomNote(t); // randomNote returns its duration
            t += duration;
        }
    }
}
