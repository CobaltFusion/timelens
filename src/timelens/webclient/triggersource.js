import { TriggerMode, TriggerState } from "./globals.js";

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
    }

    getPreTriggerUs() {
        return this.preTriggerUs;
    }

    setTriggerWord(value) {
        this.triggerWord = value;
        if (this.triggerWord === "") {
            this.triggerMode = TriggerMode.FREE;
            this.triggerState = TriggerState.Idle;
        }
        else {
            this.triggerMode = TriggerMode.AUTO;
            this.triggerState = TriggerState.Waiting;
        }
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

    stop() {
        // take a deep copy of the current data buffer
        this.data = this.collector.data().map(event => ({ ...event }));
        this.#setRunning(false);
    }

    clear() {
        this.startPointUs = this.collector.getLastTimepointUs();
    }

    auto() {

    }

    toggleRunning() {
        if (this.running) {
            this.stop();
        }
        else {
            this.#setRunning(true);
        }
    }

    single() {
        this.clear();
        this.triggerMode = TriggerMode.SINGLE;
        this.#setRunning(true);
    }

    update(graphWidthUs) {

        if (this.triggerMode === TriggerMode.FREE) {
            this.startPointUs = this.collector.getLastTimepointUs() - graphWidthUs;
            return;
        }

        const data = this.#getBufferData();
        this.dataLength = data.length;
        if (this.dataLength !== 0) {
            return;
        }

        if (this.triggerState === TriggerState.Waiting) {
            const triggerIndex = this.findTriggerIndex(data, this.triggerWord);
            if (triggerIndex === undefined) {
                // trigger specified, but not found.
                this.triggerFoundTimeUs = 0;
            }
            this.triggerFoundTimeUs = data[triggerIndex].timestamp;
            if (this.triggerMode === TriggerMode.SINGLE) {
                this.stop();
                this.triggerState = TriggerState.Found;
            }
        }
    }

    getGraphData() {
        if (this.triggerMode === TriggerMode.FREE) {
            return this.#getBufferData();
        }

        if (this.waitingForTrigger) {
            return [];
        }

        const t = this.triggerFoundTimeUs - this.preTriggerUs;
        return this.#getInternalDataBuffer().filter(
            message => message.timestamp >= t
        );
    }

    #getBufferData() {
        return this.#getInternalDataBuffer().filter(
            message => message.timestamp >= this.startPointUs
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
