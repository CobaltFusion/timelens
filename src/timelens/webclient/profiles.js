// Settings profiles, stored on the server ('/api/profiles').

const profilesUrl = "/api/profiles";

function profileUrl(name) {
    return `${profilesUrl}/${encodeURIComponent(name)}`;
}

// throws with the server's error message, if it sent one
async function throwIfFailed(response) {
    if (response.ok) {
        return;
    }
    let message = `HTTP ${response.status}`;
    try {
        const body = await response.json();
        if (body?.error) {
            message = body.error;
        }
    } catch {
        // no JSON body, keep the status
    }
    throw new Error(message);
}

/** @returns {Promise<{profiles: string[], default: string}>} */
export async function listProfiles() {
    const response = await fetch(profilesUrl);
    await throwIfFailed(response);
    return response.json();
}

/** @returns {Promise<object | null>} the profile, null if it does not exist */
export async function loadProfile(name) {
    const response = await fetch(profileUrl(name));
    if (response.status === 404) {
        return null;
    }
    await throwIfFailed(response);
    return response.json();
}

export async function saveProfile(name, profile) {
    const response = await fetch(profileUrl(name), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile)
    });
    await throwIfFailed(response);
}

export async function deleteProfile(name) {
    const response = await fetch(profileUrl(name), { method: "DELETE" });
    await throwIfFailed(response);
}
