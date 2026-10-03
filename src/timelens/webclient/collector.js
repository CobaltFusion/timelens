import { EventType } from "./globals.js";
import { performanceMonitor } from "./globals.js"
import { RingBuffer } from "./ring_buffer.js";

// Upper limit on the number of buffered events. Normally the buffer holds the last minute,
// above ~4400 events/s the oldest events are overwritten before they are a minute old.
const maxBufferedEvents = 1 << 18;

/**
 * @param {string} name
 * @param {EventTypeValue} type
 * @param {number} timestamp
 * @param {number} groupId
 * @param {number} value
 * @param {number} count
 * @param {number} processId
 * @param {number} receivedMs  browser wall time (ms since the unix epoch) the message was received
 * @returns {TSEvent}
 */
function makeEvent(name, type, timestamp, groupId, value, count, processId, receivedMs, endTime = undefined) {
    return {
        name: name,
        type: type,
        timestamp: timestamp,     // microseconds (µs)
        end_time: endTime,        // microseconds (µs), only for DURATION events
        groupId: groupId,
        value: value,
        count: count,
        processId: processId,
        receivedMs: receivedMs
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
 * For complete events with a duration:
 *   ph == 'X'  -> `ts` is the start time and `dur` the duration, this becomes
 *                 one DURATION event with `end_time` = `ts` + `dur`.
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
        this.incoming = new RingBuffer(maxBufferedEvents);
        this.running = true;
        this.audioEnabled = false;
        this.cutoffTime = 0;  // event from before this time are dropped
        this.lastTimepointUs = 0; // timepoint from the last received message
        this.lastSteadyTimepointUs = 0;
        this.onConnectionLost = null;
        this.onIncomingEvent = null;
        this.lastRequestId = 0;
        this.pendingRequests = new Map();   // requestId -> { events, resolve, reject }

        // this uses the 'host' where we are loading this application from
        const wsUrl = `ws://${window.location.host}/ws`;
        this.ws = new WebSocket(wsUrl);
        console.log("Collector connecting to", wsUrl);

        this.ws.onclose = () => {
            console.error("Connection to server closed!");
            for (const request of this.pendingRequests.values()) {
                request.reject(new Error("Connection to server closed"));
            }
            this.pendingRequests.clear();
            this.onConnectionLost?.();
        };

        // fill the buffer with the recent history, otherwise a new page starts empty
        this.ws.onopen = () => {
            this.reset().catch(error => console.error("Initial history request failed:", error));
        };

        this.ws.onmessage = (event) => {
            performanceMonitor.countWebSocketMessage();
            const data = JSON.parse(event.data);

            // replies to 'query' and 'bounds' requests, live events have no 'type' field
            if (data.type === "range" || data.type === "bounds") {
                this.#handleReply(data);
                return;
            }

            const newEvent = this.#toEvent(data);

            // timestamp never go back in time _within one logfile_ or
            // _within a 'B' -> 'E' series, but unrelated events can arrive out of order!
            this.lastTimepointUs = Math.max(newEvent.end_time ?? newEvent.timestamp, this.lastTimepointUs);
            this.lastSteadyTimepointUs = performance.now() * 1000;

            this.onIncomingEvent?.(newEvent);
            this.incoming.push(newEvent);

            const minute = 60 * 1e6; // us
            this.cutoffTime = this.lastTimepointUs - minute; // keep last minute
            this.trimIncomingData(this.cutoffTime);
        };
    }

    /** @returns {TSEvent} */
    #toEvent(data) {
        // notice that the variables MUST correspond with the actual JSON field names here!
        const { name, ph, pid, tid, ts, dur, count } = data;
        const isDuration = ph === "X";
        const endTime = isDuration ? ts + (dur ?? 0) : undefined;
        const type = isDuration ? EventType.DURATION : ph === "E" ? EventType.CLOSE : EventType.OPEN;
        const groupId = tid; // use tid as grouping for single line
        const value = 0;
        return makeEvent(name, type, ts, groupId, value, count, pid, Date.now(), endTime);
    }

    #handleReply(data) {
        const request = this.pendingRequests.get(data.requestId);
        if (!request) {
            return;
        }

        if (data.type === "bounds") {
            this.pendingRequests.delete(data.requestId);
            request.resolve({ firstUs: data.firstUs, lastUs: data.lastUs });
            return;
        }

        for (const raw of data.events) {
            request.events.push(this.#toEvent(raw));
        }
        if (data.done) {
            this.pendingRequests.delete(data.requestId);
            if (data.truncated) {
                console.warn("Range query was truncated by the server, only the newest events are included");
            }
            request.resolve(request.events);
        }
    }

    #request(message) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error("WebSocket is not connected"));
        }
        const requestId = ++this.lastRequestId;
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(requestId, { events: [], resolve, reject });
            this.ws.send(JSON.stringify({ ...message, requestId }));
        });
    }

    /**
     * Requests the events with startUs <= timestamp <= endUs from the server, oldest first.
     * The events are not added to the buffer and do not trigger 'onIncomingEvent'.
     * @returns {Promise<TSEvent[]>}
     */
    query(startUs, endUs) {
        // JSON has no Infinity, null means unbounded
        const bound = (us) => Number.isFinite(us) ? us : null;
        return this.#request({ action: "query", startUs: bound(startUs), endUs: bound(endUs) });
    }

    /**
     * The timestamps of the oldest and newest event the server has, null when it has none.
     * @returns {Promise<{firstUs: number | null, lastUs: number | null}>}
     */
    bounds() {
        return this.#request({ action: "bounds" });
    }

    clear() {
        this.incoming.clear();
    }

    // returns a reference to the RingBuffer, not a copy
    data() {
        return this.incoming;
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

    // Refills the buffer with the last minute the server has.
    async reset() {
        const { lastUs } = await this.bounds();
        if (lastUs === null) {
            return;
        }

        // live events that arrive while waiting for the reply are kept
        const keepFromSequence = this.incoming.pushCount;
        const minute = 60 * 1e6; // us
        const events = await this.query(lastUs - minute, lastUs);
        const view = this.incoming.viewFrom(keepFromSequence);
        for (let i = 0; i < view.length; ++i) {
            events.push(view.at(i));
        }

        this.clear();
        for (const event of events) {
            this.incoming.push(event);
            this.lastTimepointUs = Math.max(event.end_time ?? event.timestamp, this.lastTimepointUs);
        }
        this.lastSteadyTimepointUs = performance.now() * 1000;
    }

    asTime(msTime) {
        return this.estimatedNowUs() + (msTime * 1000 * 1000);
    }

    estimatedNowUs() {
        const nowUs = performance.now() * 1000;
        return this.lastTimepointUs + (nowUs - this.lastSteadyTimepointUs);
    }

    // drops the oldest events up to the first one at or after 'cutoffTime', nothing is copied
    trimIncomingData(cutoffTime) {
        this.incoming.dropWhile(event => event.timestamp < cutoffTime);
    }
}
