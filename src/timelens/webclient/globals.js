let debugInfo = false;

export function getDebuggingEnabled() {
    return debugInfo;
}

export function setDebuggingEnabled(value) {
    debugInfo = value;
}

export function toggleDebuggingEnabled() {
    debugInfo = !debugInfo;
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
