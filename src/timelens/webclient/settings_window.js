import { deleteProfile, listProfiles, loadProfile, saveProfile } from "./profiles.js";

/**
 * A dialog to save the current settings as a named profile on the server, and to load
 * or delete profiles. The 'default' profile is loaded when the page is opened.
 * It does not know about graphs: 'getProfile()' returns the current settings and
 * 'applyProfile(profile)' restores them.
 */
export class SettingsWindow {
    constructor({ getProfile, applyProfile }) {
        this.getProfile = getProfile;
        this.applyProfile = applyProfile;
        this.profiles = [];
        this.defaultProfile = "default";
        this.#build();
    }

    isOpen() {
        return this.dialog.open;
    }

    async open() {
        this.#setStatus("");
        this.dialog.showModal();
        await this.#refresh();
    }

    #build() {
        this.dialog = document.createElement("dialog");
        this.dialog.classList.add("settings-dialog");

        const title = document.createElement("h2");
        title.textContent = "Settings profiles";

        const description = document.createElement("p");
        description.classList.add("settings-description");
        description.textContent = "A profile holds the graphs and their trigger and view settings. " +
            "The default profile is loaded when TimeLens is opened.";

        this.list = document.createElement("select");
        this.list.classList.add("control-input", "settings-list");
        this.list.size = 8;
        this.list.title = "Profiles saved on the server";
        this.list.addEventListener("change", () => {
            this.nameInput.value = this.list.value;
        });
        this.list.addEventListener("dblclick", () => this.#load());

        const nameLabel = document.createElement("label");
        nameLabel.textContent = "Name: ";
        this.nameInput = document.createElement("input");
        this.nameInput.type = "text";
        this.nameInput.classList.add("control-input");
        this.nameInput.maxLength = 64;
        this.nameInput.title = "Name of the profile: letters, digits, space, '_', '.' and '-'";
        nameLabel.title = this.nameInput.title;
        nameLabel.appendChild(this.nameInput);

        const buttons = document.createElement("div");
        buttons.classList.add("settings-buttons");
        const addButton = (text, title, onClick) => {
            const button = document.createElement("button");
            button.type = "button";
            button.classList.add("control-button");
            button.textContent = text;
            button.title = title;
            button.addEventListener("click", onClick);
            buttons.appendChild(button);
            return button;
        };
        addButton("Load", "Replace the current graphs with the selected profile", () => this.#load());
        addButton("Save", "Save the current graphs as a profile with this name", () => this.#save(this.nameInput.value.trim()));
        addButton("Save as default", "Save the current graphs as the profile that is loaded when TimeLens is opened",
            () => this.#save(this.defaultProfile));
        addButton("Delete", "Delete the selected profile from the server", () => this.#delete());
        addButton("Close", "Close this window (Esc)", () => this.dialog.close());

        this.status = document.createElement("div");
        this.status.classList.add("settings-status");

        this.dialog.append(title, description, this.list, nameLabel, buttons, this.status);
        document.body.appendChild(this.dialog);
    }

    #setStatus(text, isError = false) {
        this.status.textContent = text;
        this.status.classList.toggle("error", isError);
    }

    async #refresh(selectName = this.nameInput.value.trim()) {
        try {
            const { profiles, default: defaultProfile } = await listProfiles();
            this.profiles = profiles;
            this.defaultProfile = defaultProfile;
        } catch (error) {
            this.#setStatus(`Could not list the profiles: ${error.message}`, true);
            return;
        }

        this.list.replaceChildren();
        for (const name of this.profiles) {
            const option = document.createElement("option");
            option.value = name;
            option.textContent = name === this.defaultProfile ? `${name} (loaded at start)` : name;
            this.list.appendChild(option);
        }
        if (this.profiles.includes(selectName)) {
            this.list.value = selectName;
        }
        if (this.profiles.length === 0) {
            this.#setStatus("No profiles saved yet.");
        }
    }

    // the selected profile, or the typed name if nothing is selected
    #selectedName() {
        return this.list.value || this.nameInput.value.trim();
    }

    async #load() {
        const name = this.#selectedName();
        if (!name) {
            this.#setStatus("Select a profile to load.", true);
            return;
        }
        try {
            const profile = await loadProfile(name);
            if (profile === null) {
                this.#setStatus(`Profile '${name}' does not exist.`, true);
                return;
            }
            this.applyProfile(profile);
            this.#setStatus(`Loaded '${name}'.`);
        } catch (error) {
            this.#setStatus(`Could not load '${name}': ${error.message}`, true);
        }
    }

    async #save(name) {
        if (!name) {
            this.#setStatus("Type a name for the profile.", true);
            return;
        }
        if (this.profiles.includes(name) && !confirm(`Overwrite profile '${name}'?`)) {
            return;
        }
        try {
            await saveProfile(name, this.getProfile());
            this.nameInput.value = name;
            await this.#refresh(name);
            this.#setStatus(`Saved '${name}'.`);
        } catch (error) {
            this.#setStatus(`Could not save '${name}': ${error.message}`, true);
        }
    }

    async #delete() {
        const name = this.#selectedName();
        if (!name) {
            this.#setStatus("Select a profile to delete.", true);
            return;
        }
        if (!confirm(`Delete profile '${name}'?`)) {
            return;
        }
        try {
            await deleteProfile(name);
            this.nameInput.value = "";
            await this.#refresh();
            this.#setStatus(`Deleted '${name}'.`);
        } catch (error) {
            this.#setStatus(`Could not delete '${name}': ${error.message}`, true);
        }
    }
}
