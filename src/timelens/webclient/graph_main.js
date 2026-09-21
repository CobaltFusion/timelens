import { Collector } from "./collector.js";
import { EventType, getAudioAlerts, getSettings } from "./globals.js";
import { NumericControl } from "./input_controls.js";
import { ResizableContainer } from "./resizable_container.js";
import { Graph } from "./graph_controls.js";

// [] array
// {} object
// [{},{}] // array of two objects
// console.log("Test");

function containsIgnoreCase(text, search) {
    return text.toLowerCase().includes(search.toLowerCase());
}

class Main {
    constructor() {
        this.widgets = new Set();
        this.collector = new Collector();
        this.connectionStatus = null;
        this.controls = document.createElement("div");
        this.controls.classList.add("control-panel");
    }

    init() {
        this.addControls();
        this.addScope();

        this.collector.onConnectionLost = () => {
            console.error("Collector connection was closed");
            this.setConnectionStatus(false)
        };

        this.collector.onIncomingEvent = (event) => {

            // beeping
            if (event.type === EventType.OPEN) {
                if (containsIgnoreCase(event.name, "error")) {
                    console.log("Error beeping");
                    getAudioAlerts().beep(1300, 0, 0.03, "square");
                    return;
                }
                if (containsIgnoreCase(event.name, "message")) {
                    console.log("Message beeping");
                    getAudioAlerts().beep(800, 0, 0.05);
                    return;
                }

                if (getSettings().isRandomSoundsEnabled()) {
                    getAudioAlerts().playPseudoRandomSound(event.name)
                    return
                }
            }
        };

        window.onresize = () => {
            this.resizeObjects();
        };

        window.onload = () => {
            this.renderObjects();
        };
    }

    resizeObjects() {
        for (const widget of this.widgets) {
            widget.resize();
        }
    }

    renderObjects() {
        const render = () => {
            for (const widget of this.widgets) {
                widget.component.render();
            }

            requestAnimationFrame(render);
        };

        render();

        //setInterval(render, 500);
    }

    setConnectionStatus(connected) {
        this.connectionStatus.textContent = connected ? "Connected" : "Disconnected";
        this.connectionStatus.style.background = connected ? "var(--status-connected)" : "var(--status-disconnected)";
    }

    addEdgeControlButton() {
        const edgeButton = document.createElement("button");
        edgeButton.classList.add("control-button");
        edgeButton.setAttribute("aria-label", "Edge mode");

        const edgeModes = [
            {
                value: "rising",
                label: "Rising edge",
                icon: `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M2 17 H8 V7 H22"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"/>
                <path d="M6 10 L8 7 L10 10"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"/>
            </svg>
        `
            },
            {
                value: "falling",
                label: "Falling edge",
                icon: `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M2 7 H8 V17 H22"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"/>
                <path d="M6 14 L8 17 L10 14"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"/>
            </svg>
        `
            },
            {
                value: "duration",
                label: "Pulse duration",
                icon: `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M2 17 H7 V7 H17 V17 H22"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"/>
            </svg>
        `
            }
        ];

        let edgeModeIndex = 0;

        const updateEdgeButton = () => {
            const mode = edgeModes[edgeModeIndex];

            edgeButton.innerHTML = mode.icon;
            edgeButton.title = mode.label;
            edgeButton.setAttribute("aria-label", mode.label);
        };

        edgeButton.addEventListener("click", () => {
            edgeModeIndex = (edgeModeIndex + 1) % edgeModes.length;
            this.edgeMode = edgeModes[edgeModeIndex].value;
            updateEdgeButton();
        });

        this.controls.appendChild(edgeButton);
        updateEdgeButton();
    }

    addControls() {
        const triggerWordLabel = document.createElement("label");
        triggerWordLabel.textContent = "Trigger word: ";
        triggerWordLabel.htmlFor = "id_trigger_word";

        const triggerWordInput = document.createElement("input");
        triggerWordInput.id = "id_trigger_word";
        triggerWordInput.type = "text";
        triggerWordInput.value = this.collector.getTriggerWord();
        triggerWordInput.classList.add("control-input");
        triggerWordInput.classList.add("numeric-control-input");

        triggerWordInput.addEventListener("input", () => {
            this.collector.setTriggerWord(triggerWordInput.value);
        });

        triggerWordLabel.appendChild(triggerWordInput);
        this.controls.appendChild(triggerWordLabel);

        //this.addEdgeControlButton()

        const preTriggerLabel = document.createElement("label");
        preTriggerLabel.textContent = "PreTrigger:";
        this.controls.appendChild(preTriggerLabel);

        new NumericControl({
            parent: this.controls,
            value: this.collector.getPreTriggerMs(),
            step: 10,
            inputStep: 1,
            min: -Infinity,
            max: -0,
            unit: "ms",
            onChange: (value) => this.collector.setPreTrigger(value)
        });

        const graphWidthLabel = document.createElement("label");
        graphWidthLabel.textContent = "View:";
        this.controls.appendChild(graphWidthLabel);

        new NumericControl({
            parent: this.controls,
            value: this.collector.getGraphWidthMs(),
            step: 10,
            inputStep: 1,
            min: 0.001,
            unit: "ms",
            onChange: (value) => {
                this.collector.setgraphWidthMs(value);
            }
        });

        const addButton = document.createElement("button");
        addButton.textContent = "Add Graph";
        addButton.classList.add("control-button");
        addButton.addEventListener("click", () => this.addScope());
        this.controls.appendChild(addButton);

        const resetButton = document.createElement("button");
        resetButton.classList.add("control-button");
        resetButton.textContent = "Reset";
        resetButton.title = "Replay the last 10 minutes of recorded data";
        resetButton.addEventListener("click", () => this.collector.reset());
        this.controls.appendChild(resetButton);

        const audioButton = document.createElement("button");
        audioButton.id = "id_audio_button";
        audioButton.classList.add("audio-button", "control-button");

        const updateAudioButton = async () => {
            const audioEnabled = await getAudioAlerts().isAudioEnabled();

            // custom drawn Speaker/Muted icon
            audioButton.innerHTML = audioEnabled
                ? `
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M3 9v6h4l5 4V5L7 9H3z"/>
                    <path d="M16 8.5a5 5 0 0 1 0 7"/>
                    <path d="M19 5.5a9 9 0 0 1 0 13"/>
                </svg>`
                : `
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M3 9v6h4l5 4V5L7 9H3z"/>
                    <path d="M16 9l5 6"/>
                    <path d="M21 9l-5 6"/>
                </svg>`;
            audioButton.setAttribute("aria-label", audioEnabled ? "Mute audio" : "Enable audio");
        };

        audioButton.addEventListener("click", async () => {
            await getAudioAlerts().toggleAudio();
            await updateAudioButton();
        });

        this.controls.appendChild(audioButton);
        updateAudioButton();

        const connectionStatus = document.createElement("button");
        connectionStatus.classList.add("connection-status", "control-button");
        connectionStatus.id = "id_connection_status";

        this.controls.appendChild(connectionStatus);
        this.connectionStatus = connectionStatus;
        this.setConnectionStatus(true);
    }

    addScope() {
        const graphPanel = document.getElementById("id_graph_panel");
        const graph = new Graph(this.collector);

        const widget = new ResizableContainer({
            parent: graphPanel,
            component: graph,
            onClose: () => {
                this.widgets.delete(widget);
            }
        });

        widget.prepend(this.controls);
        this.widgets.add(widget);
    }
}

const main = new Main();
main.init();
