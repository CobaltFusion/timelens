import { EventType, TriggerMode, TriggerResult, TriggerState } from "./globals.js";

function containsIgnoreCaseWildcard(text, search) {
    const lowerText = text.toLowerCase();
    const lowerSearch = search.toLowerCase();

    if (!lowerSearch.includes("*")) {
        return lowerText.includes(lowerSearch);
    }

    const parts = lowerSearch.split("*");
    const startsWithWildcard = lowerSearch.startsWith("*");
    const endsWithWildcard = lowerSearch.endsWith("*");

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
        this.triggerFoundTimeUs = 0;
        this.preTriggerUs = -10000; // default to -10ms
        this.singleRecordUs = 10 * 1e6;  // a single trigger records up to 10s after the trigger
        this.historyBeforeSearchUs = 60 * 1e6;  // a stopped capture keeps up to a minute before 'searchStartPointUs'
        this.triggerWord = "";
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
        this.#determineTriggerMode(TriggerMode.AUTO);
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
        this.#setRunning(false);
    }

    clear() {
        this.searchStartPointUs = this.collector.getLastTimepointUs();
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

    #isTrigger(event, triggerWord) {
        return event.type === EventType.OPEN && containsIgnoreCaseWildcard(event.name, triggerWord);
    }

    findLastTriggerIndex(data, triggerWord) {
        const index = data.findLastIndex(event => this.#isTrigger(event, triggerWord));
        return index >= 0 ? index : undefined;
    }

    findFirstTriggerIndex(data, triggerWord) {
        const index = data.findIndex(event => this.#isTrigger(event, triggerWord));
        return index >= 0 ? index : undefined;
    }

    // set this.displayStartPointUs to where we want to start the display of data
    updateStartPoint(freedisplayStartPointUs) {


        if (this.triggerMode === TriggerMode.FREE) {
            this.displayStartPointUs = freedisplayStartPointUs;
            return this.displayStartPointUs;
        }

        const data = this.#getBufferDataFrom(0);
        this.dataLength = data.length;
        if (this.dataLength === 0) {
            return 0;
        }

        if (this.triggerState === TriggerState.Waiting) {
            // single waits for the _next_ trigger, auto follows the latest one
            const triggerIndex = this.triggerMode === TriggerMode.SINGLE
                ? this.findFirstTriggerIndex(data, this.triggerWord)
                : this.findLastTriggerIndex(data, this.triggerWord);
            if (triggerIndex === undefined) {
                // trigger specified, but not found.
                this.triggerFoundTimeUs = 0;
                return 0;
            }
            this.triggerFoundTimeUs = data[triggerIndex].timestamp;
            if (this.triggerMode === TriggerMode.SINGLE) {
                this.triggerState = TriggerState.Recording;     // stop looking for triggers
            }
            if (this.triggerResult !== TriggerResult.Found) {
                this.triggerResult = TriggerResult.Found;
                this.onStatusChanged?.();
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

    // return all data from 'timePoint' and after
    #getBufferDataFrom(timePoint) {
        return this.#getInternalDataBuffer().filter(
            message => message.timestamp >= timePoint
        );
    }

    #getInternalDataBuffer() {
        if (this.running) {
            return this.collector.data().filter(
                message => message.timestamp >= this.searchStartPointUs
            );
        }
        // if not running, return the last copy in the internal data buffer
        return this.data;
    }
}



