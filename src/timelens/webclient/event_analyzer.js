import { EventType } from "./globals.js";

// Exponentially weighted mean and variance, the first samples count fully so it settles quickly.
class RunningStats {
    constructor() {
        this.mean = 0;
        this.variance = 0;
        this.count = 0;
    }

    add(value) {
        const alpha = this.count === 0 ? 1 : Math.max(0.05, 1 / (this.count + 1));
        const difference = value - this.mean;
        this.mean += alpha * difference;
        this.variance = (1 - alpha) * (this.variance + alpha * difference * difference);
        ++this.count;
    }

    // signed distance from the mean in standard deviations, the floor keeps tiny jitter
    // on very regular values from counting as unusual
    score(value, floor) {
        return (value - this.mean) / (Math.sqrt(this.variance) + floor);
    }
}

// times are compared on a log scale, so 1ms vs 2ms counts as much as 1s vs 2s
function logTime(us) {
    return Math.log10(1 + Math.max(0, us));
}

export const AnomalyKind = Object.freeze({
    NEW: "new",             // a message type that was not seen before, after warm-up
    EARLY: "early",         // arrived much sooner than usual after the previous one of its type
    LATE: "late",           // arrived much later than usual
    MISSING: "missing",     // a regular message type did not arrive for much longer than usual
    LONG: "long",           // open -> close took much longer than usual
    SHORT: "short"          // open -> close was much shorter than usual
});

/**
 * @typedef {Object} Anomaly
 * @property {string} key
 * @property {string} name
 * @property {string} kind      one of 'AnomalyKind'
 * @property {number} score     >= the threshold, how unusual it is in standard deviations
 */

/**
 * Learns what is normal per message type (name + open/close): the interval between
 * messages and the duration from open to close, and reports what is far from normal.
 */
export class EventAnalyzer {
    constructor({ warmupMessages = 1000, threshold = 4, minSamples = 8, floor = 0.07 } = {}) {
        this.warmupMessages = warmupMessages;   // new message types are not reported during warm-up
        this.threshold = threshold;             // in standard deviations of the log time
        this.minSamples = minSamples;           // samples needed before a type can be unusual
        this.floor = floor;
        this.messageCount = 0;
        this.types = new Map();         // key -> { key, name, type, lastTimestamp, interval, missingReported }
        this.durations = new Map();     // name -> RunningStats of the log duration
        this.openSince = new Map();     // "groupId:name" -> timestamp of the open event
    }

    static keyOf(event) {
        return `${event.name}:${event.type}`;
    }

    // Returns null for a normal message, otherwise { key, name, kind, score }, where
    // score >= threshold tells how unusual it is.
    /** @returns {Anomaly | null} */
    observe(event) {
        ++this.messageCount;
        const key = EventAnalyzer.keyOf(event);
        let anomaly = this.#observeInterval(key, event);

        const durationAnomaly = this.#observeDuration(event);
        if (durationAnomaly && (!anomaly || durationAnomaly.score > anomaly.score)) {
            anomaly = durationAnomaly;
        }
        return anomaly;
    }

    /** @returns {Anomaly | null} */
    #observeInterval(key, event) {
        const info = this.types.get(key);
        if (info === undefined) {
            this.types.set(key, {
                key,
                name: event.name,
                type: event.type,
                lastTimestamp: event.timestamp,
                interval: new RunningStats(),
                missingReported: false
            });
            return this.messageCount > this.warmupMessages
                ? { key, name: event.name, kind: AnomalyKind.NEW, score: this.threshold }
                : null;
        }

        const interval = logTime(event.timestamp - info.lastTimestamp);
        info.lastTimestamp = event.timestamp;
        info.missingReported = false;

        let anomaly = null;
        if (info.interval.count >= this.minSamples) {
            const score = info.interval.score(interval, this.floor);
            if (Math.abs(score) > this.threshold) {
                anomaly = { key, name: event.name, kind: score < 0 ? AnomalyKind.EARLY : AnomalyKind.LATE, score: Math.abs(score) };
            }
        }
        info.interval.add(interval);
        return anomaly;
    }

    /** @returns {Anomaly | null} */
    #observeDuration(event) {
        const openKey = `${event.groupId}:${event.name}`;
        if (event.type === EventType.OPEN) {
            this.openSince.set(openKey, event.timestamp);
            return null;
        }
        let begin;
        let end = event.timestamp;
        if (event.type === EventType.DURATION) {
            begin = event.timestamp;
            end = event.end_time ?? event.timestamp;
        }
        else if (event.type === EventType.CLOSE) {
            begin = this.openSince.get(openKey);
            if (begin === undefined) {
                return null;
            }
            this.openSince.delete(openKey);
        }
        else {
            return null;
        }

        let stats = this.durations.get(event.name);
        if (stats === undefined) {
            stats = new RunningStats();
            this.durations.set(event.name, stats);
        }

        const duration = logTime(end - begin);
        let anomaly = null;
        if (stats.count >= this.minSamples) {
            const score = stats.score(duration, this.floor);
            if (Math.abs(score) > this.threshold) {
                const key = EventAnalyzer.keyOf(event);
                anomaly = { key, name: event.name, kind: score > 0 ? AnomalyKind.LONG : AnomalyKind.SHORT, score: Math.abs(score) };
            }
        }
        stats.add(duration);
        return anomaly;
    }

    // Message types that normally arrive regularly, but have not arrived for much longer
    // than usual. Each gap is reported once, until the type arrives again.
    // Only open messages are checked, a missing close is implied by its open.
    findMissing(nowUs) {
        const missing = [];
        for (const info of this.types.values()) {
            if (info.missingReported || info.type !== EventType.OPEN || info.interval.count < this.minSamples) {
                continue;
            }
            const score = info.interval.score(logTime(nowUs - info.lastTimestamp), this.floor);
            if (score > this.threshold) {
                info.missingReported = true;
                missing.push({ key: info.key, name: info.name, kind: AnomalyKind.MISSING, score });
            }
        }
        return missing;
    }
}
