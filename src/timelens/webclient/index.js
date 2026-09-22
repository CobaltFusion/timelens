async function discoverServers() {
    const container = document.getElementById("servers");

    try {
        const response = await fetch("/api/servers");

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} `);
        }

        const data = await response.json();
        container.replaceChildren();

        if (!data.servers?.length) {
            showMessage(container, "No TimeLens servers found.");
            return;
        }

        const localAddress = window.location.hostname;
        const grouped = new Map();

        for (const server of data.servers) {
            const candidates = grouped.get(server.instance_id) ?? [];
            candidates.push(server);
            grouped.set(server.instance_id, candidates);
        }

        for (const candidates of grouped.values()) {
            const server = selectServer(candidates, localAddress);

            if (server) {
                addServer(container, server);
            } else {
                retryServer(candidates[0].instance_id);
            }
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

function selectServer(candidates, localAddress) {
    if (candidates.length === 1) {
        return candidates[0];
    }

    return candidates.find(server =>
        isAddressInSubnet(localAddress, server.subnet)
    );
}

async function retryServer(instanceId) {
    const container = document.getElementById("servers");

    try {
        const response = await fetch("/api/servers");

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} `);
        }

        const data = await response.json();

        const candidates = data.servers?.filter(
            server => server.instance_id === instanceId
        ) ?? [];

        const server = selectServer(candidates, window.location.hostname);

        if (!server) {
            setTimeout(() => retryServer(instanceId), 1000);
            return;
        }

        addServer(container, server);
    } catch (error) {
        console.error(error);
        setTimeout(() => retryServer(instanceId), 5000);
    }
}

function addServer(container, server) {
    const link = document.createElement("a");

    link.className = "server";
    link.href = `http://${server.address}:${server.port}/graph.html`;

    link.innerHTML = `
        <span class="name">${server.name}</span>
        <span class="value">${server.address}:${server.port}</span>
        <span class="value">${server.subnet}</span>
        <span class="value">${server.instance_id}</span>
    `;

    container.appendChild(link);
}

function isAddressInSubnet(address, subnet) {
    const [network, prefixLength] = subnet.split("/");
    const prefix = Number(prefixLength);

    const addressNumber = ipv4ToNumber(address);
    const networkNumber = ipv4ToNumber(network);

    if (addressNumber === null || networkNumber === null) {
        return false;
    }

    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;

    return (addressNumber & mask) === (networkNumber & mask);
}

function ipv4ToNumber(address) {
    const parts = address.split(".");

    if (parts.length !== 4) {
        return null;
    }

    let result = 0;

    for (const part of parts) {
        const value = Number(part);

        if (!Number.isInteger(value) || value < 0 || value > 255) {
            return null;
        }

        result = (result * 256) + value;
    }

    return result >>> 0;
}

function showMessage(container, message, error = false) {
    const element = document.createElement("div");
    element.className = error ? "error" : "empty";
    element.textContent = message;
    container.appendChild(element);
}

discoverServers();
