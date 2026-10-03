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
function makeEvent(name, type, timestamp, groupId, value, count, processId, receivedMs, endTime = undefined, id = undefined, color = undefined) {
    return {
        name: name,
        type: type,
        timestamp: timestamp,     // microseconds (µs)
        end_time: endTime,        // microseconds (µs), only for CLOSE and DURATION events
        groupId: groupId,
        value: value,
        count: count,
        processId: processId,
        receivedMs: receivedMs,
        id: id,                   // span id from the server
        color: color              // '#rrggbb' forced by a color filter rule, undefined otherwise
    };
}

/**
 * A Collector for spans received from the server.
 *
 * The server pairs the Chrome JSON trace events ('B'/'E'/'X') into spans:
 *   { id, name, cat, pid, tid, source, count, ts, end }
 * An open span is sent when it begins ('end' is null), the same span (same id) again when it ends.
 *
 * All timestamps (`ts` and `end`) are in microseconds (µs).
 *
 * In the buffer an open span is an OPEN event, when it ends that same event becomes a CLOSE
 * event with `timestamp` = begin and `end_time` = end.
 *
 * `onIncomingEvent` gets the events as they happen: an OPEN at the begin, a CLOSE at the end
 * (`timestamp` = end, no `end_time`), or a DURATION for a span that was never seen open.
 *
 * The `tid` field is used as the group ID, so events from the same
 * thread are displayed on the same graph line.
 */
export class Collector {
    constructor() {
        this.incoming = new RingBuffer(maxBufferedEvents);
        this.openSpans = new Map();     // span id -> buffered OPEN event, until the span ends
        this.running = true;
        this.audioEnabled = false;
        this.cutoffTime = 0;  // event from before this time are dropped
        this.lastTimepointUs = 0; // timepoint from the last received message
        this.lastSteadyTimepointUs = 0;
        this.onConnectionLost = null;
        this.onIncomingEvent = null;
        this.lastRequestId = 0;
        this.pendingRequests = new Map();   // requestId -> { spans, resolve, reject }
        this.lastTriggerId = 0;
        this.triggerWatches = new Map();    // triggerId -> { pattern, edge, callback(timeUs) }
        this.filterRules = [];              // the filter rules the server applies to everything it sends

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
            // the server handles messages in order, so the history below already arrives filtered
            if (this.filterRules.length > 0) {
                this.#request({ action: "set_filter", rules: this.filterRules })
                    .catch(error => console.error("Setting the filter failed:", error));
            }
            // watches that were started before the connection was open, e.g. from the default profile
            for (const [triggerId, { pattern, edge }] of this.triggerWatches) {
                this.#send({ action: "watch_trigger", triggerId, pattern, edge });
            }
            this.reset().catch(error => console.error("Initial history request failed:", error));
        };

        this.ws.onmessage = (event) => {
            performanceMonitor.countWebSocketMessage();
            const data = JSON.parse(event.data);

            switch (data.type) {
                case "span":
                    this.#onSpan(data);
                    return;
                case "trigger":
                    this.triggerWatches.get(data.triggerId)?.callback(data.timeUs);
                    return;
                default:
                    this.#handleReply(data);
            }
        };
    }

    /** @returns {TSEvent} */
    #toEvent(span) {
        // notice that the variables MUST correspond with the actual JSON field names here!
        const { id, name, pid, tid, ts, end, count, color } = span;
        const type = end === null ? EventType.OPEN : EventType.CLOSE;
        const groupId = tid; // use tid as grouping for single line
        const value = 0;
        return makeEvent(name, type, ts, groupId, value, count, pid, Date.now(), end ?? undefined, id, color);
    }

    #onSpan(span) {
        const openEvent = this.openSpans.get(span.id);
        let notification;

        if (span.end === null) {
            const newEvent = this.#toEvent(span);
            this.openSpans.set(span.id, newEvent);
            this.incoming.push(newEvent);
            notification = { ...newEvent };
        }
        else if (openEvent) {
            // the buffered open event becomes the closed span
            this.openSpans.delete(span.id);
            openEvent.type = EventType.CLOSE;
            openEvent.end_time = span.end;
            notification = { ...openEvent, type: EventType.CLOSE, timestamp: span.end, end_time: undefined };
        }
        else {
            // a complete span, or its begin was not received
            const newEvent = this.#toEvent(span);
            this.incoming.push(newEvent);
            notification = { ...newEvent, type: EventType.DURATION };
        }

        // timestamp never go back in time _within one logfile_ or
        // _within a 'B' -> 'E' series, but unrelated events can arrive out of order!
        this.lastTimepointUs = Math.max(span.end ?? span.ts, this.lastTimepointUs);
        this.lastSteadyTimepointUs = performance.now() * 1000;

        this.onIncomingEvent?.(notification);

        const minute = 60 * 1e6; // us
        this.cutoffTime = this.lastTimepointUs - minute; // keep last minute
        this.trimIncomingData(this.cutoffTime);
    }

    #handleReply(data) {
        const request = this.pendingRequests.get(data.requestId);
        if (!request) {
            return;
        }

        if (data.type === "range") {
            for (const span of data.spans) {
                request.spans.push(this.#toEvent(span));
            }
            if (!data.done) {
                return;
            }
            if (data.truncated) {
                console.warn("Range query was truncated by the server, only the newest spans are included");
            }
        }

        this.pendingRequests.delete(data.requestId);
        switch (data.type) {
            case "range": request.resolve(request.spans); break;
            case "bounds": request.resolve({ firstUs: data.firstUs, lastUs: data.lastUs }); break;
            case "stats": request.resolve(new Map(Object.entries(data.stats))); break;
            case "found": request.resolve(data.timeUs); break;
            case "filter":
                if (data.error) {
                    request.reject(new Error(data.error));
                }
                else {
                    request.resolve();
                }
                break;
            default: request.reject(new Error(`Unexpected reply type '${data.type}'`));
        }
    }

    isConnected() {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    #send(message) {
        if (!this.isConnected()) {
            return false;
        }
        this.ws.send(JSON.stringify(message));
        return true;
    }

    #request(message) {
        const requestId = ++this.lastRequestId;
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(requestId, { spans: [], resolve, reject });
            if (!this.#send({ ...message, requestId })) {
                this.pendingRequests.delete(requestId);
                reject(new Error("WebSocket is not connected"));
            }
        });
    }

    // JSON has no Infinity, null means unbounded
    #range(startUs, endUs) {
        const bound = (us) => Number.isFinite(us) ? us : null;
        return { startUs: bound(startUs), endUs: bound(endUs) };
    }

    /**
     * Requests the spans that overlap [startUs, endUs] from the server, ordered by begin.
     * The events are not added to the buffer and do not trigger 'onIncomingEvent'.
     * @returns {Promise<TSEvent[]>}
     */
    query(startUs, endUs) {
        return this.#request({ action: "query", ...this.#range(startUs, endUs) });
    }

    /**
     * Duration statistics per name over the closed spans that begin in [startUs, endUs].
     * @returns {Promise<Map<string, {count: number, min: number, max: number, mean: number, m2: number}>>}
     */
    stats(startUs, endUs) {
        return this.#request({ action: "stats", ...this.#range(startUs, endUs) });
    }

    /**
     * The time of the first or last edge in [startUs, endUs] of a span whose name matches
     * 'pattern' ('*' matches anything), null if there is none.
     * @param {string} edge  TriggerEdge.RISING (begin) or TriggerEdge.FALLING (end)
     * @param {"first" | "last"} which
     * @returns {Promise<number | null>}
     */
    find(pattern, edge, startUs, endUs, which) {
        return this.#request({ action: "find", pattern, edge, which, ...this.#range(startUs, endUs) });
    }

    /**
     * Calls 'callback(timeUs)' for every new edge of a span whose name matches 'pattern'.
     * @returns {() => void} stops watching
     */
    watchTrigger(pattern, edge, callback) {
        const triggerId = ++this.lastTriggerId;
        this.triggerWatches.set(triggerId, { pattern, edge, callback });
        this.#send({ action: "watch_trigger", triggerId, pattern, edge });

        return () => {
            if (this.triggerWatches.delete(triggerId)) {
                this.#send({ action: "unwatch_trigger", triggerId });
            }
        };
    }

    /**
     * Sets the filter rules the server applies to all spans, triggers, queries and statistics
     * for this client, see 'event_filter.py'. Rejects with the server's error for invalid rules,
     * the previous rules then stay. When not connected, the rules are sent when the connection opens.
     * @param {Array<{field: string, pattern: string, match: string, type: string, color?: string}>} rules
     */
    async setFilter(rules) {
        if (this.isConnected()) {
            await this.#request({ action: "set_filter", rules });
        }
        this.filterRules = rules;
    }

    /**
     * The begin time of the oldest and newest span the server has, null when it has none.
     * @returns {Promise<{firstUs: number | null, lastUs: number | null}>}
     */
    bounds() {
        return this.#request({ action: "bounds" });
    }

    clear() {
        this.incoming.clear();
        this.openSpans.clear();
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

        // spans that arrive while waiting for the reply are kept, they are newer than the fetched ones
        const keepFromSequence = this.incoming.pushCount;
        const minute = 60 * 1e6; // us
        const fetched = await this.query(lastUs - minute, Infinity);

        const kept = [];
        const view = this.incoming.viewFrom(keepFromSequence);
        for (let i = 0; i < view.length; ++i) {
            kept.push(view.at(i));
        }
        const keptIds = new Set(kept.map(event => event.id));

        this.clear();
        for (const event of [...fetched.filter(event => !keptIds.has(event.id)), ...kept]) {
            this.incoming.push(event);
            if (event.type === EventType.OPEN) {
                this.openSpans.set(event.id, event);
            }
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

    // drops the oldest events up to the first one that begins at or after 'cutoffTime', nothing is copied
    trimIncomingData(cutoffTime) {
        this.incoming.dropWhile(event => {
            if (event.timestamp >= cutoffTime) {
                return false;
            }
            this.openSpans.delete(event.id);
            return true;
        });
    }
}
