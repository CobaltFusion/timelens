// Measures the latency and the bandwidth between this browser and a TimeLens server, with the endpoints
// '/api/speedtest/...' of the server. It has no DOM, so it can also run in Node.
//
// All sizes are in megabytes of 1024 * 1024 bytes, and the speeds in megabytes per second.

export const MEGABYTE = 1024 * 1024;

// The most the server sends or accepts in one request, see 'speedtest.py'.
export const MAX_BYTES = 256 * MEGABYTE;

// The least that is sent in a run of the continuous test, to keep a run long enough to measure.
const MIN_RUN_BYTES = 64 * 1024;

/** The results of a continuous test are the average of this many milliseconds. */
export const ROLLING_MS = 20_000;

/**
 * @typedef {Object} Options
 * @property {AbortSignal} [signal]           stops the measurement, the call then rejects
 * @property {typeof fetch} [fetch]           to test with, default 'fetch'
 * @property {() => number} [now]             the time in ms, to test with, default 'performance.now'
 */

/**
 * @typedef {Object} Latency
 * @property {number} minMs
 * @property {number} avgMs
 * @property {number} maxMs
 * @property {number} medianMs      less sensitive to a single slow request than the average
 * @property {number[]} samples     the round trips in ms, in the order they were made
 */

/** Megabytes per second of 'bytes' that were transferred in 'seconds'. */
export function speedOf(bytes, seconds) {
    return bytes / seconds / MEGABYTE;
}

/** The statistics of round trips in ms. @param {number[]} samples @returns {Latency} */
export function latencyOf(samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const medianMs = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    return {
        minMs: sorted[0],
        avgMs: samples.reduce((sum, ms) => sum + ms, 0) / samples.length,
        maxMs: sorted[sorted.length - 1],
        medianMs,
        samples: [...samples]
    };
}

// ---- a guess of the speed of the line

/** The speeds of Ethernet that are guessed, in megabits per second (a megabit is 1,000,000 bits). */
export const LINE_SPEEDS_MBIT = [10, 100, 1000, 2500, 5000, 10000];

// A line can not carry data at its full speed: the headers of TCP, IP and Ethernet take about 5% of it (a full
// frame has 1460 bytes of data in 1538 bytes on the line).
export const LINE_EFFICIENCY = 1460 / 1538;

/** Megabits per second of a speed in MB/s. */
export function megabitsOf(mbps) {
    return mbps * MEGABYTE * 8 / 1e6;
}

/**
 * A guess of the line: the slowest of the speeds of Ethernet that could have carried the best speed that was measured,
 * with the share of it that is left for data. It is a guess: a slow server or computer, or other traffic, makes the line
 * look slower than it is. Null when the speed is more than the fastest line carries: a server on this computer, or a
 * line that is faster than 10 Gbps.
 * @param {number} bestMBps
 * @returns {number | null} the line in megabits per second
 */
export function guessLine(bestMBps) {
    const mbit = megabitsOf(bestMBps);
    return LINE_SPEEDS_MBIT.find(line => mbit <= line * LINE_EFFICIENCY) ?? null;
}

/** The part of a line that a speed in MB/s uses, in percent of the speed of the line (not of what is left for data). */
export function lineShare(mbps, lineMbit) {
    return megabitsOf(mbps) / lineMbit * 100;
}

/** The name of a line: "100 Mbps", "2.5 Gbps". */
export function lineLabel(lineMbit) {
    return lineMbit >= 1000 ? `${lineMbit / 1000} Gbps` : `${lineMbit} Mbps`;
}

// ---- single requests

/** @param {Options} options */
function environment(options) {
    return {
        signal: options.signal,
        fetchFn: options.fetch ?? globalThis.fetch.bind(globalThis),
        now: options.now ?? (() => performance.now())
    };
}

/** @typedef {ReturnType<typeof environment>} Environment */

async function checked(response, what) {
    if (!response.ok) {
        throw new Error(`${what}: HTTP ${response.status}`);
    }
    return response;
}

// reads a body to the end, returns the number of bytes in it
async function readAll(response) {
    let received = 0;
    const reader = response.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            return received;
        }
        received += value.length;
    }
}

/** The round trip of one small request, in ms. @param {Environment} env */
async function pingRun({ signal, fetchFn, now }, baseUrl) {
    const start = now();
    await checked(await fetchFn(`${baseUrl}/api/speedtest/ping`, { cache: "no-store", signal }), "latency");
    return now() - start;
}

/**
 * One download of 'bytes' bytes: the time from the arrival of the headers to the last byte, so the latency is not in it.
 * @param {Environment} env
 * @returns {Promise<{bytes: number, seconds: number}>}
 */
async function downloadRun({ signal, fetchFn, now }, baseUrl, bytes) {
    const response = await checked(await fetchFn(`${baseUrl}/api/speedtest/download?bytes=${bytes}`, { cache: "no-store", signal }), "download");
    const start = now();
    const received = await readAll(response);
    const seconds = (now() - start) / 1000;
    if (received !== bytes) {
        throw new Error(`download: ${received} of ${bytes} bytes arrived`);
    }
    return { bytes: received, seconds };
}

/**
 * One upload of 'body': the start of an upload can not be told from the sending of it, so the time is that of the
 * whole request, less one round trip for the answer ('latencySeconds').
 * @param {Environment} env
 * @param {Uint8Array<ArrayBuffer>} body
 * @returns {Promise<{bytes: number, seconds: number}>}
 */
async function uploadRun({ signal, fetchFn, now }, baseUrl, body, latencySeconds) {
    // 'text/plain' keeps this a simple request: the browser does not ask the server first, which would cost a round trip
    const start = now();
    const response = await checked(await fetchFn(`${baseUrl}/api/speedtest/upload`, {
        method: "POST", body, headers: { "Content-Type": "text/plain" }, cache: "no-store", signal
    }), "upload");
    const answer = await response.json();
    const seconds = (now() - start) / 1000 - latencySeconds;
    if (answer.bytes !== body.length) {
        throw new Error(`upload: the server got ${answer.bytes} of ${body.length} bytes`);
    }
    return { bytes: body.length, seconds };
}

// ---- one test

/**
 * The round trip of 'count' small requests, one after the other. An extra request is made first and not
 * counted: it opens the connection, which is not what a request normally costs.
 * @param {string} baseUrl  '' for the server of this page, otherwise 'http://address:port'
 * @param {Options & {count?: number}} [options]
 * @returns {Promise<Latency>}
 */
export async function measureLatency(baseUrl, options = {}) {
    const env = environment(options);
    const samples = [];

    for (let i = 0; i <= (options.count ?? 20); ++i) {
        const ms = await pingRun(env, baseUrl);
        if (i > 0) {
            samples.push(ms);
        }
    }
    return latencyOf(samples);
}

/**
 * Makes requests until one has taken long enough to measure, each one sized from the speed of the one before.
 * Returns the speed of the last one, in MB/s.
 * @param {(bytes: number) => Promise<{bytes: number, seconds: number}>} run  transfers 'bytes' and tells how long it took
 * @param {{targetMs: number, startBytes?: number, maxBytes?: number}} limits
 */
async function ramp(run, { targetMs, startBytes = MEGABYTE, maxBytes = MAX_BYTES }) {
    let bytes = startBytes;
    for (;;) {
        const { bytes: transferred, seconds: measured } = await run(bytes);
        const seconds = Math.max(measured, 1e-6);       // the clock of a browser is not exact, a tiny run can read as zero

        // a run of a quarter of the target is long enough, shorter ones are too much affected by the start
        if (seconds * 1000 >= targetMs / 4 || bytes >= maxBytes) {
            return speedOf(transferred, seconds);
        }
        const factor = Math.min(16, Math.max(2, targetMs / 1000 / seconds));
        bytes = Math.min(maxBytes, Math.round(bytes * factor));
    }
}

/**
 * The download speed in MB/s.
 * @param {string} baseUrl
 * @param {Options & {targetMs?: number}} [options]
 */
export async function measureDownload(baseUrl, options = {}) {
    const env = environment(options);
    return ramp(bytes => downloadRun(env, baseUrl, bytes), { targetMs: options.targetMs ?? 1500 });
}

/**
 * The upload speed in MB/s.
 * @param {string} baseUrl
 * @param {Options & {targetMs?: number, latencyMs?: number}} [options]
 */
export async function measureUpload(baseUrl, options = {}) {
    const env = environment(options);
    const latencySeconds = (options.latencyMs ?? 0) / 1000;
    return ramp(bytes => uploadRun(env, baseUrl, new Uint8Array(bytes), latencySeconds), { targetMs: options.targetMs ?? 1500 });
}

/**
 * The latency, the download and the upload of a server, one after the other.
 * 'onPhase(phase, resultSoFar)' is called when a phase begins: 'latency', 'download' and 'upload'.
 * @param {string} baseUrl
 * @param {Options & {onPhase?: (phase: string, resultSoFar: object) => void}} [options]
 * @returns {Promise<{latency: Latency, download: number, upload: number}>}
 */
export async function runTest(baseUrl, options = {}) {
    const onPhase = options.onPhase ?? (() => { });

    onPhase("latency", {});
    const latency = await measureLatency(baseUrl, options);

    onPhase("download", { latency });
    const download = await measureDownload(baseUrl, options);

    onPhase("upload", { latency, download });
    const upload = await measureUpload(baseUrl, { ...options, latencyMs: latency.medianMs });

    return { latency, download, upload };
}

// ---- a test that keeps running

/**
 * @typedef {Object} Samples    what was measured, with the time it was done
 * @property {Array<{t: number, ms: number}>} pings
 * @property {Array<{t: number, bytes: number, seconds: number}>} downloads
 * @property {Array<{t: number, bytes: number, seconds: number}>} uploads
 */

/**
 * @typedef {Object} Rolling
 * @property {Latency} [latency]    the round trips of the last 'windowMs', undefined when there is none yet
 * @property {number} [download]    MB/s of the downloads of the last 'windowMs': all their bytes divided by all their time
 * @property {number} [upload]
 */

/**
 * The results of what was measured in the last 'windowMs' before 'now'. A speed is the bytes of all the runs that
 * finished in that time, divided by the time of all those runs, so a long run counts for more than a short one.
 * @param {Samples} samples
 * @param {number} now
 * @param {number} [windowMs]
 * @returns {Rolling}
 */
export function rollingResult(samples, now, windowMs = ROLLING_MS) {
    const since = now - windowMs;

    const pings = samples.pings.filter(ping => ping.t >= since).map(ping => ping.ms);
    const speed = (/** @type {Samples["downloads"]} */ runs) => {
        const inWindow = runs.filter(run => run.t >= since);
        const seconds = inWindow.reduce((sum, run) => sum + run.seconds, 0);
        return inWindow.length === 0 ? undefined : speedOf(inWindow.reduce((sum, run) => sum + run.bytes, 0), Math.max(seconds, 1e-6));
    };

    return {
        latency: pings.length === 0 ? undefined : latencyOf(pings),
        download: speed(samples.downloads),
        upload: speed(samples.uploads)
    };
}

/**
 * Measures until 'signal' stops it (the call then rejects with the AbortError). It goes round and round: a few
 * round trips while the line is quiet, then a download of about a second, then an upload of about a second, each sized
 * from the one before. 'onUpdate(result)' is called after every step, with the average of the last 'windowMs': the results
 * of a longer ago have gone out of it, and 'seconds' is how much of the window has been measured so far.
 * @param {string} baseUrl
 * @param {Options & {onUpdate?: (result: Rolling & {seconds: number}) => void, windowMs?: number, targetMs?: number, pingsPerRound?: number}} [options]
 * @returns {Promise<never>}
 */
export async function runContinuous(baseUrl, options = {}) {
    const env = environment(options);
    const { signal, now } = env;
    const windowMs = options.windowMs ?? ROLLING_MS;
    const targetMs = options.targetMs ?? 1000;
    const pingsPerRound = options.pingsPerRound ?? 5;
    const onUpdate = options.onUpdate ?? (() => { });

    /** @type {Samples} */
    const samples = { pings: [], downloads: [], uploads: [] };
    const started = now();

    const update = () => {
        const t = now();
        const since = t - windowMs;
        samples.pings = samples.pings.filter(ping => ping.t >= since);
        samples.downloads = samples.downloads.filter(run => run.t >= since);
        samples.uploads = samples.uploads.filter(run => run.t >= since);
        onUpdate({ ...rollingResult(samples, t, windowMs), seconds: Math.min(windowMs, t - started) / 1000 });
    };

    // The size of the next run: what takes about 'targetMs' at the speed of the run that was just made.
    const nextBytes = (bytes, seconds) => {
        const factor = Math.min(16, Math.max(0.25, targetMs / 1000 / Math.max(seconds, 1e-6)));
        return Math.min(MAX_BYTES, Math.max(MIN_RUN_BYTES, Math.round(bytes * factor)));
    };

    // the body of an upload is kept and made bigger when needed, a body of many megabytes is not made again every second
    /** @type {Uint8Array<ArrayBuffer>} */
    let body = new Uint8Array(0);
    const bodyOf = (/** @type {number} */ bytes) => {
        if (body.length < bytes) {
            body = new Uint8Array(bytes);
        }
        return body.subarray(0, bytes);
    };

    let downloadBytes = MEGABYTE;
    let uploadBytes = MEGABYTE;

    for (let round = 0; ; ++round) {
        signal?.throwIfAborted();

        // The first request of the first round only opens the connection, it is not counted.
        for (let i = round === 0 ? -1 : 0; i < pingsPerRound; ++i) {
            const ms = await pingRun(env, baseUrl);
            if (i >= 0) {
                samples.pings.push({ t: now(), ms });
            }
        }
        update();

        const download = await downloadRun(env, baseUrl, downloadBytes);
        samples.downloads.push({ t: now(), ...download });
        downloadBytes = nextBytes(downloadBytes, download.seconds);
        update();

        const latency = rollingResult(samples, now(), windowMs).latency;
        const upload = await uploadRun(env, baseUrl, bodyOf(uploadBytes), (latency?.medianMs ?? 0) / 1000);
        samples.uploads.push({ t: now(), ...upload });
        uploadBytes = nextBytes(uploadBytes, upload.seconds);
        update();
    }
}
