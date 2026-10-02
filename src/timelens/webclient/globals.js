import { AudioAlerts } from "./audioalerts.js";
import { PerformanceMonitor } from "./performancemonitor.js"

export class Settings {
    constructor() {
        this.debugging = false;
        this.randomSoundsEnabled = false;
    }

    isDebuggingEnabled() {
        return this.debugging;
    }

    setDebuggingEnabled(value) {
        this.debugging = value;
    }

    toggleDebuggingEnabled() {
        this.debugging = !this.debugging;
    }

    isRandomSoundsEnabled() {
        return this.randomSoundsEnabled;
    }

    setRandomSoundsEnabled(value) {
        this.randomSoundsEnabled = value;
    }
    toggleRandomSoundsEnabled() {
        this.randomSoundsEnabled = !this.randomSoundsEnabled;
    }
}

const settings = new Settings()
export function getSettings() {
    return settings;
}

const audioAlerts = new AudioAlerts();
export function getAudioAlerts() {
    return audioAlerts;
}

/**
 * @typedef {"open" | "close" | "duration" | "value"} EventTypeValue
 */

export const EventType = Object.freeze({
    OPEN: "open",           // only has timestamp
    CLOSE: "close",         // has both timestamp and end_time
    DURATION: "duration",   // has both timestamp and end_time
    VALUE: "value"          // has timestamp + value
});

export const TriggerMode = Object.freeze({
    AUTO: "Auto",           // every trigger is automatically re-triggers
    SINGLE: "Single",       // the first next trigger will stop data-collection after graphWidthMs
    FREE: "Free"            // set when no 'trigger word' is set, will keep collecting data and show the last graphWidthMs
});

export const TriggerState = Object.freeze({
    Idle: "Idle",
    Waiting: "Waiting",  // looking for trigger
});

export const TriggerResult = Object.freeze({
    None: "None",
    Found: "Found"
});


/**
 * @typedef {Object} TSEvent
 * @property {string} name
 * @property {EventTypeValue} type
 * @property {number} timestamp
 * @property {number} [end_time]
 * @property {number} [groupId]
 * @property {number} [value]
 */

export function roundUpNice(value) {
    if (value <= 0) {
        return 0;
    }

    const magnitude = 10 ** Math.floor(Math.log10(value));
    const normalized = value / magnitude;

    let nice;
    if (normalized <= 1) {
        nice = 1;
    } else if (normalized <= 2) {
        nice = 2;
    } else if (normalized <= 5) {
        nice = 5;
    } else {
        nice = 10;
    }

    return nice * magnitude;
}

export const performanceMonitor = new PerformanceMonitor();

