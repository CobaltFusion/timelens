import { EventType, TriggerEdge, TriggerMode, TriggerResult, TriggerState } from "./globals.js";

// Returns a function that tests a text against 'search', case-insensitive, '*' matches anything.
// The search word is prepared once, so testing only lowercases the text.
function makeWildcardMatcher(search) {
    const lowerSearch = search.toLowerCase();

    if (!lowerSearch.includes("*")) {
        return text => text.toLowerCase().includes(lowerSearch);
    }

    const parts = lowerSearch.split("*");
    const startsWithWildcard = lowerSearch.startsWith("*");
    const endsWithWildcard = lowerSearch.endsWith("*");

    return text => {
        const lowerText = text.toLowerCase();
        let position = 0;

        for (const part of parts) {
            if (!part) {
                continue;
            }

            const found = lowerText.indexOf(part, position);

            if (found === -1) {
                return false;
            }

            position = found + part.length;
        }

        if (!startsWithWildcard && !lowerText.startsWith(parts[0])) {
            return false;
        }

        if (!endsWithWildcard && !lowerText.endsWith(parts[parts.length - 1])) {
            return false;
        }

        return true;
    };
}

export class TriggerSource {
    constructor(collector) {
        this.collector = collector;
        this.triggerMode = TriggerMode.FREE;
        this.triggerState = TriggerState.Idle;
        this.running = true;
        this.data = null;
        this.displayStartPointUs = 0;
        this.searchStartPointUs = 0;      // after 'clear()' we do not include the whole buffer anymore.
        this.searchStartSequence = 0;     // the same point as a sequence number in the collector's buffer
        this.scannedSequence = 0;         // while running, events before this sequence number were searched for the trigger
        this.stoppedDataScanned = false;  // while stopped, the copy in 'this.data' was searched for the trigger
        this.triggerFoundTimeUs = 0;
        this.preTriggerUs = -10000; // default to -10ms
        this.singleRecordUs = 10 * 1e6;  // a single trigger records up to 10s after the trigger
        this.historyBeforeSearchUs = 60 * 1e6;  // a stopped capture keeps up to a minute before 'searchStartPointUs'
        this.triggerWord = "";
        this.triggerMatcher = makeWildcardMatcher("");
        this.triggerEdge = TriggerEdge.RISING;
        this.dataLength = 0;
        this.onStatusChanged = null;
    }

    setPreTriggerUs(value) {
        this.preTriggerUs = value;
    }

    getPreTriggerUs() {
        return this.preTriggerUs;
    }

    setTriggerWord(value) {
        this.triggerWord = value;
        this.triggerMatcher = makeWildcardMatcher(value);
        this.#determineTriggerMode(TriggerMode.AUTO);
    }

    setTriggerEdge(value) {
        this.triggerEdge = value;
        this.#determineTriggerMode(TriggerMode.AUTO);
    }

    getTriggerEdge() {
        return this.triggerEdge;
    }

    #determineTriggerMode(triggerMode) {
        if (this.triggerWord) {
            this.triggerMode = triggerMode;
            this.triggerState = TriggerState.Waiting;
        }
        else {
            this.triggerMode = TriggerMode.FREE;
            this.triggerState = TriggerState.Idle;
        }
        this.triggerResult = TriggerResult.None;
        this.triggerFoundTimeUs = 0;
        // search everything again
        this.scannedSequence = 0;
        this.stoppedDataScanned = false;
        this.onStatusChanged?.();
    }

    // null when no trigger word is set (free running)
    getTriggerStatus() {
        if (this.triggerMode === TriggerMode.FREE) {
            return null;
        }
        if (this.triggerMode === TriggerMode.AUTO) {
            return "Auto";
        }
        return this.triggerResult === TriggerResult.Found ? "Triggered" : "Wait";
    }

    // 0..1 while a single capture is recording after its trigger, otherwise null
    getRecordingProgress() {
        if (!this.running || this.triggerState !== TriggerState.Recording) {
            return null;
        }
        const elapsedUs = this.collector.estimatedNowUs() - this.triggerFoundTimeUs;
        return Math.min(Math.max(elapsedUs / this.singleRecordUs, 0), 1);
    }

    getTriggerWord() {
        return this.triggerWord;
    }

    #setRunning(value) {
        this.running = value;
        this.onStatusChanged?.();
    }

    isRunning() {
        return this.running;
    }

    // stops collecting, events after 'endUs' are not included, nor events more than
    // 'historyBeforeSearchUs' before the search start point
    #stop(endUs = Infinity) {
        const beginUs = this.searchStartPointUs - this.historyBeforeSearchUs;
        // take a deep copy of the current data buffer
        this.data = this.collector.data()
            .filter(event => event.timestamp >= beginUs && event.timestamp <= endUs)
            .map(event => ({ ...event }));
        this.stoppedDataScanned = false;
        this.#setRunning(false);
    }

    clear() {
        this.searchStartPointUs = this.collector.getLastTimepointUs();
        this.searchStartSequence = this.collector.data().pushCount;
    }

    // drops the copy that is shown while stopped
    clearCopy() {
        if (!this.running) {
            this.data = [];
        }
    }

    auto() {
        this.#determineTriggerMode(TriggerMode.AUTO);
    }

    toggleRunning() {
        if (this.running) {
            this.#stop();
        }
        else {
            // a finished single capture continues as auto, otherwise it would just show the old trigger
            if (this.triggerMode === TriggerMode.SINGLE) {
                this.auto();
            }
            this.#setRunning(true);
        }
    }

    single() {
        this.clear();
        this.#determineTriggerMode(TriggerMode.SINGLE);
        if (!this.running) {
            this.#setRunning(true);
        }
    }

    // In single mode the trigger stays fixed after it is found, recording continues until
    // 'singleRecordUs' after the trigger, then data collection stops.
    #updateSingleRecording() {
        const recordEndUs = this.triggerFoundTimeUs + this.singleRecordUs;
        if (this.collector.estimatedNowUs() >= recordEndUs) {
            this.triggerState = TriggerState.Idle;
            this.#stop(recordEndUs);
        }
    }

    #isTrigger(event) {
        // in the raw data a 'B' is an OPEN event and an 'E' is a CLOSE event, both at their own timestamp,
        // a DURATION event has both edges
        const edgeType = this.triggerEdge === TriggerEdge.FALLING ? EventType.CLOSE : EventType.OPEN;
        return (event.type === edgeType || event.type === EventType.DURATION) && this.triggerMatcher(event.name);
    }

    // the time of the selected edge, only a DURATION event has its falling edge at 'end_time'
    #triggerTimeUs(event) {
        if (this.triggerEdge === TriggerEdge.FALLING && event.type === EventType.DURATION) {
            return event.end_time ?? event.timestamp;
        }
        return event.timestamp;
    }

    // Searches only the events that were not searched before, 'data' has 'length' and 'at(i)'.
    // Single waits for the _next_ trigger, auto follows the latest one.
    // Returns the trigger event, or undefined if none of the new events is a trigger.
    #findNewTrigger(data) {
        let from;
        if (this.running) {
            from = Math.max(0, this.scannedSequence - data.firstSequence);
            this.scannedSequence = data.firstSequence + data.length;
        }
        else {
            from = this.stoppedDataScanned ? data.length : 0;
            this.stoppedDataScanned = true;
        }

        if (this.triggerMode === TriggerMode.SINGLE) {
            for (let i = from; i < data.length; ++i) {
                const event = data.at(i);
                if (this.#isTrigger(event)) {
                    return event;
                }
            }
            return undefined;
        }

        for (let i = data.length - 1; i >= from; --i) {
            const event = data.at(i);
            if (this.#isTrigger(event)) {
                return event;
            }
        }
        return undefined;
    }

    // set this.displayStartPointUs to where we want to start the display of data
    updateStartPoint(freedisplayStartPointUs) {
        if (this.triggerMode === TriggerMode.FREE) {
            this.displayStartPointUs = freedisplayStartPointUs;
            return this.displayStartPointUs;
        }

        const data = this.#getInternalDataBuffer();
        this.dataLength = data.length;
        if (this.dataLength === 0) {
            return 0;
        }

        if (this.triggerState === TriggerState.Waiting) {
            const trigger = this.#findNewTrigger(data);
            if (trigger !== undefined) {
                this.triggerFoundTimeUs = this.#triggerTimeUs(trigger);
                if (this.triggerMode === TriggerMode.SINGLE) {
                    this.triggerState = TriggerState.Recording;     // stop looking for triggers
                }
                if (this.triggerResult !== TriggerResult.Found) {
                    this.triggerResult = TriggerResult.Found;
                    this.onStatusChanged?.();
                }
            }
            else if (this.triggerResult !== TriggerResult.Found) {
                // trigger specified, but not found (yet).
                return 0;
            }
        }

        if (this.triggerState === TriggerState.Recording) {
            this.#updateSingleRecording();
        }
        // derived on every update, so changing the pre-trigger also applies to a trigger that was already found
        this.displayStartPointUs = this.triggerFoundTimeUs + this.preTriggerUs;
        return this.displayStartPointUs;
    }

    getGraphData() {

        // this makes the display empty during 'waiting' state
        if (this.triggerResult === TriggerState.Waiting && this.triggerResult === TriggerResult.None) {
            return [];
        }
        // not filtered on displayStartPointUs, events that started before the view can still be (partly) visible
        return this.#getInternalDataBuffer();
    }

    // all data the graph can currently show, regardless of the display start point
    getAllData() {
        return this.#getInternalDataBuffer();
    }

    // Returns something with 'length' and 'at(i)', not a copy: while running a view on the
    // collector's buffer from the search start point onwards, while stopped the copy taken at stop.
    #getInternalDataBuffer() {
        if (this.running) {
            return this.collector.data().viewFrom(this.searchStartSequence);
        }
        // if not running, return the last copy in the internal data buffer
        return this.data;
    }
}



