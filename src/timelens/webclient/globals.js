import { AudioAlerts } from "./audioalerts.js";

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

export const EventType = {
    OPEN: "open",           // only has timestamp
    CLOSE: "close",         // has both timestamp and end_time
    DURATION: "duration",   // has both timestamp and end_time
    VALUE: "value"          // has timestamp + value
};

/**
 * @typedef {Object} TSEvent
 * @property {string} name
 * @property {EventTypeValue} type
 * @property {number} timestamp
 * @property {number} [end_time]
 * @property {number} [groupId]
 * @property {number} [value]
 */
