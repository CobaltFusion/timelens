import { TriggerEdge, TriggerMode, TriggerResult, TriggerState } from "./globals.js";

export class TriggerSource {
    constructor(collector) {
        this.collector = collector;
        /** @type {typeof TriggerMode[keyof typeof TriggerMode]} */
        this.triggerMode = TriggerMode.FREE;
        /** @type {typeof TriggerState[keyof typeof TriggerState]} */
        this.triggerState = TriggerState.Idle;
        /** @type {typeof TriggerResult[keyof typeof TriggerResult]} */
        this.triggerResult = TriggerResult.None;
        this.running = true;
        this.data = null;                 // while stopped, the events fetched from the server for the stopped range
        this.stoppedRange = null;         // while stopped, { beginUs, endUs } of the fetched events
        this.fetchGeneration = 0;         // replies to older fetches are ignored
        this.triggerGeneration = 0;       // trigger replies for an older search are ignored
        this.unwatchTrigger = null;       // stops the server watch for the trigger word
        this.displayStartPointUs = 0;
        this.searchStartPointUs = 0;      // after 'clear()' we do not include the whole buffer anymore.
        this.searchStartSequence = 0;     // the same point as a sequence number in the collector's buffer
        this.triggerFoundTimeUs = 0;
        this.preTriggerUs = -10000; // default to -10ms
        this.singleRecordUs = 10 * 1e6;  // a single trigger records up to 10s after the trigger
        this.historyBeforeSearchUs = 60 * 1e6;  // a stopped capture keeps up to a minute before 'searchStartPointUs'
        this.bufferedHistoryUs = 60 * 1e6;      // the collector's buffer holds the last minute
        this.triggerWord = "";
        /** @type {typeof TriggerEdge[keyof typeof TriggerEdge]} */
        this.triggerEdge = TriggerEdge.RISING;
        /** @type {import("./globals.js").TriggerDuration | null} */
        this.triggerDuration = null;      // only events with this duration trigger, null for any duration
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

    setTriggerEdge(value) {
        this.triggerEdge = value;
        this.#determineTriggerMode(TriggerMode.AUTO);
    }

    getTriggerEdge() {
        return this.triggerEdge;
    }

    /** @param {import("./globals.js").TriggerDuration | null} value */
    setTriggerDuration(value) {
        this.triggerDuration = value;
        this.#determineTriggerMode(TriggerMode.AUTO);
    }

    getTriggerDuration() {
        return this.triggerDuration;
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
        this.#searchTrigger();
        this.onStatusChanged?.();
    }

    // The server searches for the trigger: while running it reports every new trigger, in auto
    // mode the latest trigger that is already in the data is looked up as well. While stopped,
    // the latest trigger in the stopped range is looked up.
    #searchTrigger() {
        this.#stopWatching();
        if (this.triggerMode === TriggerMode.FREE || this.triggerState !== TriggerState.Waiting) {
            return;
        }

        const generation = this.triggerGeneration;
        const onTrigger = (timeUs) => this.#onTrigger(generation, timeUs);
        const onError = (error) => console.error("Trigger search failed:", error);

        if (!this.running) {
            if (this.stoppedRange) {
                const { beginUs, endUs } = this.stoppedRange;
                this.collector.find(this.triggerWord, this.triggerEdge, beginUs, endUs, "last", this.triggerDuration).then(onTrigger).catch(onError);
            }
            return;
        }

        this.unwatchTrigger = this.collector.watchTrigger(this.triggerWord, this.triggerEdge, onTrigger, this.triggerDuration);
        if (this.triggerMode === TriggerMode.AUTO) {
            const { beginUs } = this.getDataRangeUs();
            this.collector.find(this.triggerWord, this.triggerEdge, beginUs, Infinity, "last", this.triggerDuration).then(onTrigger).catch(onError);
        }
    }

    #stopWatching() {
        ++this.triggerGeneration;
        this.unwatchTrigger?.();
        this.unwatchTrigger = null;
    }

    // Single uses the _next_ trigger, auto follows the latest one.
    #onTrigger(generation, timeUs) {
        if (generation !== this.triggerGeneration || timeUs === null || this.triggerState !== TriggerState.Waiting) {
            return;
        }

        if (this.triggerMode === TriggerMode.SINGLE) {
            this.triggerFoundTimeUs = timeUs;
            this.triggerState = TriggerState.Recording;     // stop looking for triggers
            this.#stopWatching();
        }
        else if (this.triggerResult !== TriggerResult.Found || timeUs > this.triggerFoundTimeUs) {
            this.triggerFoundTimeUs = timeUs;
        }

        if (this.triggerResult !== TriggerResult.Found) {
            this.triggerResult = TriggerResult.Found;
            this.onStatusChanged?.();
        }
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

    isRunning() {
        return this.running;
    }

    // The time range of the data the graph shows: while running the buffered events from the
    // search start point onwards, while stopped the fetched range.
    getDataRangeUs() {
        if (!this.running && this.stoppedRange) {
            return this.stoppedRange;
        }
        const bufferBeginUs = this.collector.getLastTimepointUs() - this.bufferedHistoryUs;
        return { beginUs: Math.max(this.searchStartPointUs, bufferBeginUs), endUs: Infinity };
    }

    // stops collecting, events after 'endUs' are not included, nor events more than
    // 'historyBeforeSearchUs' before the search start point
    #stop(endUs = Infinity) {
        const lastTimepointUs = this.collector.getLastTimepointUs();
        const beginUs = Math.max(this.searchStartPointUs - this.historyBeforeSearchUs, lastTimepointUs - this.bufferedHistoryUs);
        const stoppedRange = { beginUs, endUs: Math.min(endUs, lastTimepointUs) };
        const generation = ++this.fetchGeneration;
        this.stoppedRange = stoppedRange;
        this.data = [];
        this.running = false;
        this.#searchTrigger();      // while waiting for a trigger, look in the stopped range
        this.onStatusChanged?.();
        this.#fetchStoppedRange(stoppedRange, generation);
    }

    // the stopped range is requested from the server instead of copying the buffer
    #fetchStoppedRange({ beginUs, endUs }, generation) {
        this.collector.query(beginUs, endUs)
            .then(events => {
                if (generation === this.fetchGeneration && !this.running) {
                    this.data = events;
                }
            })
            .catch(error => console.error("Fetching the stopped range failed:", error));
    }

    // fetches the stopped range again, e.g. after the filter changed, the current data is shown until it arrives
    refetch() {
        if (!this.running && this.stoppedRange) {
            this.#fetchStoppedRange(this.stoppedRange, ++this.fetchGeneration);
        }
    }

    #start() {
        ++this.fetchGeneration;     // a reply that is still underway is no longer wanted
        this.data = null;
        this.stoppedRange = null;
        this.running = true;
        this.#searchTrigger();
        this.onStatusChanged?.();
    }

    clear() {
        this.searchStartPointUs = this.collector.getLastTimepointUs();
        this.searchStartSequence = this.collector.data().pushCount;
    }

    // drops the data fetched for the stopped range
    clearFetched() {
        if (!this.running) {
            ++this.fetchGeneration;
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
            this.#start();
        }
    }

    single() {
        this.clear();
        if (!this.running) {
            this.#start();
        }
        this.#determineTriggerMode(TriggerMode.SINGLE);
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

    // set this.displayStartPointUs to where we want to start the display of data
    updateStartPoint(freedisplayStartPointUs) {
        if (this.triggerMode === TriggerMode.FREE) {
            this.displayStartPointUs = freedisplayStartPointUs;
            return this.displayStartPointUs;
        }

        if (this.triggerResult !== TriggerResult.Found) {
            // trigger specified, but not found (yet).
            return 0;
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
    // collector's buffer from the search start point onwards, while stopped the fetched events.
    #getInternalDataBuffer() {
        if (this.running) {
            return this.collector.data().viewFrom(this.searchStartSequence);
        }
        // if not running, return the events fetched for the stopped range
        return this.data;
    }
}
