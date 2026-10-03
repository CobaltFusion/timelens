import { deleteProfile, listProfiles, loadProfile, saveProfile } from "./profiles.js";

/**
 * @typedef {Object} FilterRule
 * @property {string} field
 * @property {string} pattern
 * @property {string} match
 * @property {string} type
 * @property {string} [color]   only for color rules
 */

// the choices of a filter rule, see 'event_filter.py' on the server
const filterFields = [
    { value: "name", label: "name" },
    { value: "cat", label: "category" },
    { value: "source", label: "source" },
    { value: "pid", label: "pid" },
    { value: "tid", label: "tid" }
];
const filterMatches = [
    { value: "normal", label: "normal" },
    { value: "regex", label: "regex" }
];
const filterTypes = [
    { value: "include", label: "include" },
    { value: "exclude", label: "exclude" },
    { value: "color", label: "color" }
];
const defaultFilterColor = "#ff4040";

/**
 * A dialog to save the current settings as a named profile on the server, and to load
 * or delete profiles. The 'default' profile is loaded when the page is opened.
 * It also edits the filter rules, the server applies them to all events it sends.
 * It does not know about graphs: 'getProfile()' returns the current settings and
 * 'applyProfile(profile)' restores them, 'getFilters()' and 'applyFilters(rules)' do the same for the filter.
 */
export class SettingsWindow {
    constructor({ getProfile, applyProfile, getFilters, applyFilters }) {
        this.getProfile = getProfile;
        this.applyProfile = applyProfile;
        this.getFilters = getFilters;
        this.applyFilters = applyFilters;
        this.profiles = [];
        this.defaultProfile = "default";

        // created here and filled by '#build()', so they are never undefined
        this.dialog = document.createElement("dialog");
        this.list = document.createElement("select");
        this.nameInput = document.createElement("input");
        this.status = document.createElement("div");
        this.filterRows = document.createElement("div");
        /** @type {Map<Element, () => FilterRule>} */
        this.ruleOfRow = new Map();     // row element -> () => rule as edited
        this.#build();
    }

    isOpen() {
        return this.dialog.open;
    }

    async open() {
        this.#setStatus("");
        this.#showFilters(this.getFilters());
        this.dialog.showModal();
        await this.#refresh();
    }

    #build() {
        this.dialog.classList.add("settings-dialog");

        const title = document.createElement("h2");
        title.textContent = "Settings profiles";

        const description = document.createElement("p");
        description.classList.add("settings-description");
        description.textContent = "A profile holds the graphs and their trigger and view settings. " +
            "The default profile is loaded when TimeLens is opened.";

        this.list.classList.add("control-input", "settings-list");
        this.list.size = 8;
        this.list.title = "Profiles saved on the server";
        this.list.addEventListener("change", () => {
            this.nameInput.value = this.list.value;
        });
        this.list.addEventListener("dblclick", () => this.#load());

        const nameLabel = document.createElement("label");
        nameLabel.textContent = "Name: ";
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

        this.status.classList.add("settings-status");

        // an 'x' at the top right and a Close button at the bottom right, both close the window
        const closeX = document.createElement("button");
        closeX.type = "button";
        closeX.classList.add("settings-close-x");
        closeX.textContent = "x";
        closeX.title = "Close this window (Esc)";
        closeX.setAttribute("aria-label", "Close");
        closeX.addEventListener("click", () => this.dialog.close());

        const footer = document.createElement("div");
        footer.classList.add("settings-footer");
        const close = document.createElement("button");
        close.type = "button";
        close.classList.add("control-button");
        close.textContent = "Close";
        close.title = closeX.title;
        close.addEventListener("click", () => this.dialog.close());
        footer.appendChild(close);

        this.dialog.append(closeX, title, description, this.list, nameLabel, buttons, ...this.#buildFilters(), this.status, footer);
        document.body.appendChild(this.dialog);
    }

    #buildFilters() {
        const title = document.createElement("h2");
        title.textContent = "Filters";

        const description = document.createElement("p");
        description.classList.add("settings-description");
        description.textContent = "The server applies the filters to all events: filtered events are not shown, " +
            "do not trigger and are not counted in the statistics. Include rules are combined with OR, without " +
            "include rules all events are included. An exclude rule wins over all include rules. " +
            "The first matching color rule sets the color of an event. The filters are saved in the profile.";

        this.filterRows.classList.add("filter-rows");

        const buttons = document.createElement("div");
        buttons.classList.add("settings-buttons");

        const addRule = document.createElement("button");
        addRule.type = "button";
        addRule.classList.add("control-button");
        addRule.textContent = "Add rule";
        addRule.title = "Add a filter rule";
        addRule.addEventListener("click", () => this.#addFilterRow().focus());

        const apply = document.createElement("button");
        apply.type = "button";
        apply.classList.add("control-button");
        apply.textContent = "Apply filters";
        apply.title = "Send the filter rules to the server, the graphs are filled again with the filtered events";
        apply.addEventListener("click", () => this.#applyFilters().catch(() => { }));

        const removeAll = document.createElement("button");
        removeAll.type = "button";
        removeAll.classList.add("control-button");
        removeAll.textContent = "Remove all";
        removeAll.title = "Remove all filter rules and apply that right away, all events are shown again";
        removeAll.addEventListener("click", () => {
            this.#showFilters([]);
            this.#applyFilters().catch(() => { });
        });

        buttons.append(addRule, apply, removeAll);
        return [title, description, this.filterRows, buttons];
    }

    #makeSelect(choices, value, title) {
        const select = document.createElement("select");
        select.classList.add("control-input");
        select.title = title;
        for (const choice of choices) {
            const option = document.createElement("option");
            option.value = choice.value;
            option.textContent = choice.label;
            select.appendChild(option);
        }
        select.value = choices.some(choice => choice.value === value) ? value : choices[0].value;
        return select;
    }

    // Adds one row for 'rule', returns its pattern input.
    #addFilterRow(rule = {}) {
        const row = document.createElement("div");
        row.classList.add("filter-row");

        const field = this.#makeSelect(filterFields, rule.field, "The field of the event the pattern is matched against");

        const pattern = document.createElement("input");
        pattern.type = "text";
        pattern.classList.add("control-input");
        pattern.value = rule.pattern ?? "";
        pattern.placeholder = "pattern";
        pattern.title = "Normal: case-insensitive, '*' matches any text, without '*' it matches anywhere. " +
            "Regex: a case-insensitive regular expression that can match anywhere. An empty rule is ignored";

        const match = this.#makeSelect(filterMatches, rule.match,
            "How the pattern is matched: normal (like the trigger word) or a regular expression");
        const type = this.#makeSelect(filterTypes, rule.type,
            "include: show only matching events (rules are OR-ed), exclude: never show matching events, " +
            "color: force a color on matching events");

        const color = document.createElement("input");
        color.type = "color";
        color.classList.add("filter-color");
        color.value = rule.color ?? defaultFilterColor;
        color.title = "The color of matching events";

        const updateColor = () => {
            color.hidden = type.value !== "color";
        };
        type.addEventListener("change", updateColor);
        updateColor();

        const remove = document.createElement("button");
        remove.type = "button";
        remove.classList.add("control-button");
        remove.textContent = "x";
        remove.title = "Remove this rule, press 'Apply filters' to send the change to the server";
        remove.addEventListener("click", () => {
            row.remove();
            this.ruleOfRow.delete(row);
        });

        row.append(field, pattern, match, type, color, remove);
        this.ruleOfRow.set(row, () => {
            /** @type {FilterRule} */
            const result = { field: field.value, pattern: pattern.value, match: match.value, type: type.value };
            if (type.value === "color") {
                result.color = color.value;
            }
            return result;
        });
        this.filterRows.appendChild(row);
        return pattern;
    }

    #showFilters(rules) {
        this.filterRows.replaceChildren();
        this.ruleOfRow.clear();
        for (const rule of rules) {
            this.#addFilterRow(rule);
        }
    }

    // the rules as edited, without empty rows
    #editedFilters() {
        // the map is in the order the rows were added, which is the order they are shown
        return [...this.ruleOfRow.values()]
            .map(readRule => readRule())
            .filter(rule => rule.pattern.trim() !== "");
    }

    // shows the result, and rethrows an error so a save can be stopped
    async #applyFilters() {
        const rules = this.#editedFilters();
        try {
            await this.applyFilters(rules);
            this.#setStatus(rules.length === 0 ? "No filters." : `Applied ${rules.length} filter rule(s).`);
        } catch (error) {
            this.#setStatus(`Could not apply the filters: ${error.message}`, true);
            throw error;
        }
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
            try {
                await this.applyProfile(profile);
                this.#setStatus(`Loaded '${name}'.`);
            } catch (error) {
                this.#setStatus(`Loaded '${name}', but its filters are invalid: ${error.message}`, true);
            }
            this.#showFilters(this.getFilters());
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
        // the profile holds the filters as edited, so they are applied first
        try {
            await this.#applyFilters();
        } catch {
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
