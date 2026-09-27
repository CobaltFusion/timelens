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
        this.startPointUs = 0;      // after 'clear()' we do not include the whole buffer anymore.
        this.triggerFoundTimeUs = 0;
        this.preTriggerUs = -10000; // default to -10ms
        this.triggerWord = "";
        this.dataLength = 0;
        this.onStatusChanged = null;
    }

    setPreTriggerUs(value) {
        this.preTriggerUs = value;
        this.#determineTriggerMode(TriggerMode.AUTO);
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

    #stop() {
        // take a deep copy of the current data buffer
        this.data = this.collector.data().map(event => ({ ...event }));
        this.#setRunning(false);
    }

    clear() {
        this.startPointUs = this.collector.getLastTimepointUs();
    }

    auto() {
        this.#determineTriggerMode(TriggerMode.AUTO);
    }

    toggleRunning() {
        if (this.running) {
            this.#stop();
        }
        else {
            this.#setRunning(true);
        }
    }

    single() {
        this.clear();
        this.#determineTriggerMode(TriggerMode.SINGLE);
    }

    findLastTriggerIndex(data, triggerWord) {
        const index = data.findLastIndex(event =>
            event.type === EventType.OPEN &&
            containsIgnoreCaseWildcard(event.name, triggerWord));
        return index >= 0 ? index : undefined;
    }

    // set this.startPointUs to where we want to start the display of data
    updateStartPoint(freeStartPointUs) {

        if (this.triggerMode === TriggerMode.FREE) {
            this.startPointUs = freeStartPointUs;
            return this.startPointUs;
        }

        const data = this.#getBufferDataFrom(0);
        this.dataLength = data.length;
        if (this.dataLength === 0) {
            return 0;
        }

        if (this.triggerState === TriggerState.Waiting) {
            const triggerIndex = this.findLastTriggerIndex(data, this.triggerWord);
            if (triggerIndex === undefined) {
                // trigger specified, but not found.
                this.triggerFoundTimeUs = 0;
                return 0;
            }
            this.triggerResult = TriggerResult.Found;
            this.triggerFoundTimeUs = data[triggerIndex].timestamp;
            this.startPointUs = this.triggerFoundTimeUs + this.preTriggerUs;
            if (this.triggerMode === TriggerMode.SINGLE) {
                this.#stop();
            }
        }
        return this.startPointUs;
    }

    getGraphData() {

        // this makes the display empty during 'waiting' state
        if (this.triggerResult === TriggerState.Waiting && this.triggerResult === TriggerResult.None) {
            return [];
        }
        return this.#getBufferDataFrom(this.startPointUs);
    }

    // return all data from 'timePoint' and after
    #getBufferDataFrom(timePoint) {
        return this.#getInternalDataBuffer().filter(
            message => message.timestamp >= timePoint
        );
    }

    #getInternalDataBuffer() {
        if (this.running) {
            return this.collector.data();
        }
        // if not running, return the last copy in the internal data buffer
        return this.data;
    }
}
