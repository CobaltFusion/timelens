import { EventType } from "./globals.js";

/**
 * @param {string} name
 * @param {EventTypeValue} type
 * @param {number} timestamp
 * @param {number} groupId
 * @param {number} value
 * @returns {TSEvent}
 */
function makeEvent(name, type, timestamp, groupId, value, count) {
    return {
        name: name,
        type: type,
        timestamp: timestamp,     // microseconds (µs)
        groupId: groupId,
        value: value,
        count: count
    };
}

/**
 * A Collector for events received in Chrome JSON trace format.
 *
 * Incoming WebSocket messages are expected to contain Chrome JSON trace-style event
 * fields:
 *   name, cat, ph, pid, tid, ts
 *
 * All timestamps (`ts` and `te`) are in microseconds (µs).
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
export class Collector {
    constructor() {
        this.incoming = []; // this an array of structs, if GC becomes a problem, we should turn this into a struct of arrays for zero-reallocation
        this.running = true;
        this.audioEnabled = false;
        this.cutoffTime = 0;  // event from before this time are dropped
        this.triggerWord = "";
        this.graphWidthMs = 1000;
        this.preTriggerMs = -10;
        this.lastTimepointUs = 0;
        this.lastSteadyTimepointUs = 0;
        this.onConnectionLost = null;
        this.onIncomingEvent = null;

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
            const { name, cat, ph, pid, tid, ts, count } = data;

            // timestamp never go back in time _within one logfile_ or
            // _within a 'B' -> 'E' series, but unrelated events can arrive out of order!
            this.lastTimepointUs = Math.max(ts, this.lastTimepointUs);
            this.lastSteadyTimepointUs = performance.now() * 1000;

            const type = ph === "E" ? EventType.CLOSE : EventType.OPEN;
            const groupId = tid; // use tid as grouping for single line
            const value = 0;
            const newEvent = makeEvent(name, type, ts, groupId, value, count);
            this.onIncomingEvent?.(newEvent);
            this.incoming.push(newEvent);

            const minute = 60 * 1e6; // us
            this.cutoffTime = this.lastTimepointUs - minute; // keep last minute
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

    setgraphWidthMs(milliseconds) {
        const value = Number(milliseconds);

        if (Number.isFinite(value) && value > 0) {
            this.graphWidthMs = value;
        }
    }

    getGraphWidthMs() {
        return this.graphWidthMs;
    }

    setPreTrigger(milliseconds) {
        this.preTriggerMs = milliseconds;
    }

    getPreTriggerMs() {
        return this.preTriggerMs;
    }

    getLastTimepointUs() {
        return this.lastTimepointUs;
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
        this.lastTimepointUs = 0;
        this.lastSteadyTimepointUs = 0;
        this.clear();

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("Cannot reset: WebSocket is not connected");
        }

        // if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        //     this.ws.send(JSON.stringify({ type: "control", action: "reset" }));
        // }

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const minus10minutesUs = this.estimateNowUs() - (10 * 60 * 1e6)
            this.ws.send(JSON.stringify({ type: "control", action: "request", timeUs: minus10minutesUs }));
        }

    }

    asTime(msTime) {
        return this.estimateNowUs() + (msTime * 1000 * 1000);
    }

    estimateNowUs() {
        const nowUs = performance.now() * 1000;
        return this.lastTimepointUs + (nowUs - this.lastSteadyTimepointUs);
    }

    toggleRandomSounds() {

    }

    dummy() {
        this.incoming.push(makeEvent("capture_image", EventType.DURATION, this.asTime(10), 0, 0));
        this.incoming.push(makeEvent("process_image", EventType.OPEN, this.asTime(13), 0, 0, 0));
        this.incoming.push(makeEvent("set_outputs", EventType.DURATION, this.asTime(15), this.asTime(40), 0, 0));
        this.incoming.push(makeEvent("process_image", EventType.CLOSE, this.asTime(0), this.asTime(20), 0, 0)); // intentionally out-of-order
        //this.incoming.push(makeEvent("cycle", EventType.CLOSE, this.asTime(0), this.asTime(500), 0 ,0)); // intentionally omitted

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
