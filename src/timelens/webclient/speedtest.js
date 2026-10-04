// The speed test page: the latency and the bandwidth between this browser and the discovered servers. The table has
// all servers, the one that the page was opened for (?server=address:port) is highlighted.

import { requireElement } from "./dom.js";
import { fetchServers } from "./servers.js";
import { MEGABYTE, guessLine, lineLabel, lineShare, megabitsOf, runContinuous, runTest } from "./speedtest_client.js";

/**
 * @typedef {Object} Row
 * @property {import("./servers.js").DiscoveredServer} server
 * @property {string} baseUrl
 * @property {Record<string, HTMLElement>} cells
 * @property {HTMLButtonElement} button
 * @property {AbortController | null} controller    set while the row is being tested
 * @property {number} peak      the best download or upload speed of this test in MB/s, the guess of the line is made from it
 */

/** @type {Row[]} */
const rows = [];

// The server of this page is called with relative urls, any other server directly: the server allows that, and the
// result is then the speed between this browser and that server.
function baseUrlOf(server) {
    return `${server.address}:${server.port}` === window.location.host ? "" : `http://${server.address}:${server.port}`;
}

// The server that this page was opened for, 'address:port' from the address of the page (the link of a server
// in the server list), or null. It is highlighted in the table, the table has all servers.
const selectedAddress = new URLSearchParams(window.location.search).get("server");

const addressOf = (server) => `${server.address}:${server.port}`;

// A server for an 'address:port' that was not discovered, so it can be tested too.
function serverOf(address) {
    const colon = address.lastIndexOf(":");
    const port = Number(address.slice(colon + 1));
    if (colon < 1 || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`'${address}' is not a server, use address:port`);
    }
    return { name: address, address: address.slice(0, colon), port, subnet: "", instance_id: "" };
}

// All servers that were discovered, and the selected one when it is not among them.
async function serversToTest() {
    let servers = [];
    try {
        servers = await fetchServers();
    } catch (error) {
        if (!selectedAddress) {
            throw error;
        }       // the selected server can be tested without the discovery
    }
    if (selectedAddress && !servers.some(server => addressOf(server) === selectedAddress)) {
        servers.push(serverOf(selectedAddress));
    }
    return servers;
}

function makeCell(row, className = "") {
    const cell = document.createElement("td");
    cell.className = className;
    row.appendChild(cell);
    return cell;
}

// the box of 'Keep running until Stop'
function keepRunningBox() {
    const box = requireElement("id_keep_running");
    if (!(box instanceof HTMLInputElement)) {
        throw new Error("id_keep_running is not a checkbox");
    }
    return box;
}

function addRow(server) {
    const tr = document.createElement("tr");
    if (addressOf(server) === selectedAddress) {
        tr.className = "selected";
        tr.title = "The server that this page was opened for";
    }

    const serverCell = makeCell(tr, "left");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = server.name;
    const address = document.createElement("span");
    address.className = "value";
    address.textContent = `${server.address}:${server.port}`;
    serverCell.append(name, address);

    const cells = {
        min: makeCell(tr, "number"), avg: makeCell(tr, "number"), max: makeCell(tr, "number"),
        download: makeCell(tr, "number"), upload: makeCell(tr, "number"),
        line: makeCell(tr, "left line"), status: makeCell(tr, "left status")
    };
    const button = document.createElement("button");
    button.className = "button";
    makeCell(tr).appendChild(button);

    /** @type {Row} */
    const row = { server, baseUrl: baseUrlOf(server), cells, button, controller: null, peak: 0 };
    button.addEventListener("click", () => (row.controller ? row.controller.abort() : testRow(row)));
    rows.push(row);
    requireElement("id_servers").appendChild(tr);
    showStatus(row, "");
}

const decimals = (value, digits = 1) => (value === undefined ? "" : value.toFixed(digits));

const percent = (value) => `${Math.round(value)}%`;

/**
 * The guess of the line that fits the best speed of this test, and the part of it that the speeds use now.
 * @param {Row} row
 * @param {number | undefined} download
 * @param {number | undefined} upload
 */
function showLine(row, download, upload) {
    const cell = row.cells.line;
    cell.replaceChildren();
    cell.title = "";
    if (!(row.peak > 0)) {
        return;
    }

    const guess = guessLine(row.peak);
    const name = document.createElement("span");
    name.className = "guess";
    const share = document.createElement("span");
    share.className = "share";
    cell.append(name, share);

    const best = `${row.peak.toFixed(1)} MB/s (${megabitsOf(row.peak).toFixed(0)} Mbit/s)`;
    if (guess === null) {
        name.textContent = "> 10 Gbps";
        cell.title = `The best speed, ${best}, is more than the fastest line of 10 Gbps carries: the server is on this computer, or the line is faster.`;
        return;
    }

    name.textContent = lineLabel(guess);
    share.textContent = [["down", download], ["up", upload]]
        .filter(([, speed]) => speed !== undefined)
        .map(([direction, speed]) => `${direction} ${percent(lineShare(speed, guess))}`)
        .join(" · ");
    cell.title = `A guess: the best speed of this test, ${best}, fits in a line of ${lineLabel(guess)}, which is at most ` +
        `${(guess * 1e6 / 8 / MEGABYTE).toFixed(1)} MB/s. The percentages are of that speed of the line.`;
}

/**
 * Shows what is known: 'result' has the parts that are done.
 * @param {Row} row
 * @param {{latency?: import("./speedtest_client.js").Latency, download?: number, upload?: number}} [result]
 */
function showResult(row, { latency, download, upload } = {}) {
    row.cells.min.textContent = decimals(latency?.minMs, 2);
    row.cells.avg.textContent = decimals(latency?.avgMs, 2);
    row.cells.max.textContent = decimals(latency?.maxMs, 2);
    row.cells.download.textContent = decimals(download);
    row.cells.upload.textContent = decimals(upload);

    row.peak = Math.max(row.peak, download ?? 0, upload ?? 0);
    showLine(row, download, upload);
}

function showStatus(row, text, isError = false) {
    row.cells.status.textContent = text;
    row.cells.status.classList.toggle("failed", isError);
    row.button.textContent = row.controller ? "Stop" : "Test";
    row.button.title = row.controller ? "Stop the test of this server" : "Test this server";

    const running = rows.some(r => r.controller);
    requireElement("id_test_all").toggleAttribute("disabled", rows.every(r => r.controller));
    requireElement("id_stop").toggleAttribute("disabled", !running);
    keepRunningBox().disabled = running;        // a test that runs is not changed
}

// the error of a request that was stopped with 'Stop'
const isAbort = (error) => error instanceof Error && error.name === "AbortError";

function describe(error) {
    if (isAbort(error)) {
        return "stopped";
    }
    // fetch only says 'Failed to fetch' when the server is not there, or when it does not allow this page
    return error instanceof TypeError ? "no answer from the server" : error.message;
}

// Tests one server, the results are shown as they come in. Never rejects: a failure is shown in the row.
// With 'Keep running until Stop' it goes on until it is stopped, and the results are the average of the last 20 seconds.
async function testRow(row) {
    if (row.controller) {
        return;     // it is being tested
    }
    const keepRunning = keepRunningBox().checked;
    row.controller = new AbortController();
    row.peak = 0;
    showResult(row);
    showStatus(row, "testing the latency...");

    try {
        if (keepRunning) {
            await runContinuous(row.baseUrl, {
                signal: row.controller.signal,
                onUpdate: (result) => {
                    showResult(row, result);
                    showStatus(row, `running, average of the last ${Math.max(1, Math.round(result.seconds))} s`);
                }
            });
            return;     // it never ends by itself: Stop ends it with an AbortError, shown below
        }

        const result = await runTest(row.baseUrl, {
            signal: row.controller.signal,
            onPhase: (phase, soFar) => {
                showResult(row, soFar);
                showStatus(row, `testing the ${phase}...`);
            }
        });
        showResult(row, result);
        row.controller = null;
        showStatus(row, "done");
    } catch (error) {
        row.controller = null;
        showStatus(row, describe(error), !isAbort(error));
    }
}

async function main() {
    const message = requireElement("id_message");

    requireElement("id_test_all").addEventListener("click", () => Promise.all(rows.map(testRow)));
    requireElement("id_stop").addEventListener("click", () => rows.forEach(row => row.controller?.abort()));
    requireElement("id_test_all").toggleAttribute("disabled", true);

    try {
        const servers = await serversToTest();
        if (servers.length === 0) {
            message.textContent = "No TimeLens servers found.";
            return;
        }
        servers.forEach(addRow);
        message.hidden = true;
        requireElement("id_results").hidden = false;
        requireElement("id_test_all").toggleAttribute("disabled", false);
    } catch (error) {
        console.error(error);
        message.className = "error";
        message.textContent = `Failed to discover servers: ${error instanceof Error ? error.message : error}`;
    }
}

main();
