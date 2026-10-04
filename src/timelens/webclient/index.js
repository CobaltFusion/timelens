import { requireElement } from "./dom.js";
import { fetchServers } from "./servers.js";

async function discoverServers() {
    const container = requireElement("servers");

    try {
        const servers = await fetchServers();
        container.replaceChildren();

        if (servers.length === 0) {
            showMessage(container, "No TimeLens servers found.");
            return;
        }

        for (const server of servers) {
            addServer(container, server);
        }
    } catch (error) {
        console.error(error);
        container.replaceChildren();

        showMessage(
            container,
            `Failed to discover servers: ${error.message}.Retrying in 5 seconds...`,
            true
        );

        setTimeout(discoverServers, 5000);
    }
}

// A server is a row with two links: the graphs of the server, and its speed test.
function addServer(container, server) {
    const row = document.createElement("div");
    row.className = "server";

    const link = document.createElement("a");
    link.className = "server-link";
    link.href = `http://${server.address}:${server.port}/graph.html`;

    // text, not html: the name is what the other machine says it is called
    for (const [className, text] of [
        ["name", server.name],
        ["value", `${server.address}:${server.port}`],
        ["value", server.subnet],
        ["value", server.instance_id]
    ]) {
        const span = document.createElement("span");
        span.className = className;
        span.textContent = text;
        link.appendChild(span);
    }

    const speed = document.createElement("a");
    speed.className = "server-speed";
    speed.href = `speedtest.html?server=${encodeURIComponent(`${server.address}:${server.port}`)}`;
    speed.textContent = "Speed test";
    speed.title = "Measure the latency and the bandwidth between this browser and this server";

    row.append(link, speed);
    container.appendChild(row);
}

function showMessage(container, message, error = false) {
    const element = document.createElement("div");
    element.className = error ? "error" : "empty";
    element.textContent = message;
    container.appendChild(element);
}

discoverServers();
