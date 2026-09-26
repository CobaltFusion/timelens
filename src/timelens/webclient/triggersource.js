import { TriggerMode } from "./globals.js";

export class TriggerSource {
    constructor(collector) {
        this.collector = collector;
        this.triggerMode = TriggerMode.AUTO;
        this.running = true;
        this.data = null;
        this.startPointUs = 0;      // after 'clear()' we do not include the whole buffer anymore.
        this.preTriggerUs = -10000; // default to -10ms
    }

    setPreTriggerUs(value) {
        this.preTriggerUs = value;
    }

    getPreTriggerUs() {
        return this.preTriggerUs;
    }

    clear() {
        this.startPointUs = this.collector.getLastTimepointUs();
    }

    single() {

    }

    stop() {
        // take a deep copy of the current data buffer
        this.data = this.collector.data().map(event => ({ ...event }));
        this.running = false;
    }

    toggleRunning() {
        if (this.running) {
            this.stop();
        }
        else {
            this.running = true;
            this.data = null
        }
    }

    getData() {
        return this.getDataBuffer().filter(
            message => message.timestamp >= this.startPointUs
        );
    }

    getDataBuffer() {
        if (this.running) {
            return this.collector.data();
        }
        else {
            return this.data;
        }
    }
}
