// The TimeLens servers that were discovered on the local network, as the server of this page sees them.

/**
 * @typedef {Object} DiscoveredServer
 * @property {string} name
 * @property {string} address
 * @property {number} port
 * @property {string} subnet
 * @property {string} instance_id
 */

/**
 * The servers, one per instance: a server that has several network interfaces answers more than once, then the
 * address in the same subnet as this browser is used. When none is, all its addresses are listed.
 * @returns {Promise<DiscoveredServer[]>}
 */
export async function fetchServers() {
    const response = await fetch("/api/servers");
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const grouped = new Map();
    for (const server of data.servers ?? []) {
        const candidates = grouped.get(server.instance_id) ?? [];
        candidates.push(server);
        grouped.set(server.instance_id, candidates);
    }

    const servers = [];
    for (const candidates of grouped.values()) {
        const server = selectServer(candidates, window.location.hostname);
        servers.push(...(server === undefined ? candidates : [server]));
    }
    return servers;
}

function selectServer(candidates, localAddress) {
    if (candidates.length === 1) {
        return candidates[0];
    }

    return candidates.find(server => isAddressInSubnet(localAddress, server.subnet));
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
