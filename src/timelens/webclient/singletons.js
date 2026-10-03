// The audio output and the performance monitor of the page. They are created when this module is
// first imported, so only the pages that need them import it: 'globals.js' does not, so a page
// like the server list can import that without starting an AudioContext or the monitor.
import { AudioAlerts } from "./audioalerts.js";
import { PerformanceMonitor } from "./performancemonitor.js";

const audioAlerts = new AudioAlerts();
export function getAudioAlerts() {
    return audioAlerts;
}

export const performanceMonitor = new PerformanceMonitor();
