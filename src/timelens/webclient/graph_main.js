import { Collector } from "./collector.js";
import { EventType, getAudioAlerts, getSettings } from "./globals.js";
import { NumericControl } from "./input_controls.js";
import { ResizableContainer } from "./resizable_container.js";
import { Graph } from "./graph.js";
import { TrafficIndication } from "./traffic_indication.js";
import { HealthIndication } from "./health_indication.js";


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
        this.trafficIndication = null;
        this.healthIndication = null;

        const topPanel = document.getElementById("id_top_panel");

        this.addButton = document.createElement("button");
        this.addButton.textContent = "Add Graph";
        this.addButton.classList.add("control-button");
        this.addButton.addEventListener("click", () => this.addScope());
        topPanel.appendChild(this.addButton);

        this.resetButton = document.createElement("button");
        this.resetButton.classList.add("control-button");
        this.resetButton.textContent = "Reset";
        this.resetButton.title = "Replay the last 10 minutes of recorded data";
        this.resetButton.addEventListener("click", () => this.collector.reset());
        topPanel.appendChild(this.resetButton);

        this.clearButton = document.createElement("button");
        this.clearButton.classList.add("control-button");
        this.clearButton.textContent = "Clear";
        this.clearButton.title = "Remove all received events from the buffer";
        this.clearButton.addEventListener("click", () => this.clearAll());
        topPanel.appendChild(this.clearButton);

        this.audioButton = document.createElement("button");
        this.audioButton.id = "id_audio_button";
        this.audioButton.classList.add("audio-button", "control-button");
        topPanel.appendChild(this.audioButton);

        this.updateAudioButton();

        this.connectionStatus = document.createElement("button");
        this.connectionStatus.classList.add("connection-status", "control-button");
        this.connectionStatus.id = "id_connection_status";
        topPanel.appendChild(this.connectionStatus);

        this.setConnectionStatus(true);

        document.addEventListener("keydown", (e) => {
            this.keyHandler(e);
        });

        this.incomingTraffic = document.createElement("span");
        this.incomingTraffic.classList.add("incoming-traffic");
        this.incomingTraffic.title = "Incoming traffic";
        topPanel.appendChild(this.incomingTraffic);

        this.trafficIndication = new TrafficIndication(topPanel);
        this.healthIndication = new HealthIndication(topPanel);
    }

    keyHandler(e) {
        // don't steal keys while typing, e.g. in the trigger word field
        const target = e.target;
        if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) {
            return;
        }
        if (e.ctrlKey || e.altKey || e.metaKey) {
            return;
        }

        const key = e.key.toLowerCase();
        // pan/zoom acts on the selected graph, and freezes it on the current data until 'q' or RUN is pressed
        const graph = ResizableContainer.getSelected()?.component;
        const panFraction = 0.1;
        const zoomFactor = 1.25;
        switch (key) {
            case "a": graph?.pan(-panFraction); return;
            case "d": graph?.pan(panFraction); return;
            case "w": graph?.zoom(1 / zoomFactor); return;
            case "s": graph?.zoom(zoomFactor); return;
            case "q": graph?.resume(); return;
        }

        if (key === "i") {
            getSettings().toggleDebuggingEnabled();
        }
        if (key === "r") {
            getSettings().toggleRandomSoundsEnabled();
        }
        if (key === "b") {
            getAudioAlerts().alertBeep();
        }
    }

    async updateAudioButton() {
        const audioEnabled = await getAudioAlerts().isAudioEnabled();

        // custom drawn Speaker/Muted icon
        this.audioButton.innerHTML = audioEnabled
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

        this.audioButton.setAttribute(
            "aria-label",
            audioEnabled ? "Mute audio" : "Enable audio"
        );
    }

    init() {
        this.addScope();

        this.audioButton.addEventListener("click", async () => {
            await getAudioAlerts().toggleAudio();
            await this.updateAudioButton();
        });

        this.collector.onConnectionLost = () => {
            console.error("Collector connection was closed");
            this.setConnectionStatus(false);
        };

        this.collector.onIncomingEvent = (event) => {
            this.trafficIndication.onIncomingEvent();
            this.healthIndication.onIncomingEvent(event);

            this.incomingTraffic.classList.add("active");
            clearTimeout(this.incomingTrafficTimer);
            this.incomingTrafficTimer = setTimeout(() => {
                this.incomingTraffic.classList.remove("active");
            }, 100);

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
                    getAudioAlerts().playPseudoRandomSound(event.name);
                    return;
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

    // empties the shared buffer and the copies kept by stopped or panned/zoomed graphs
    clearAll() {
        this.collector.clear();
        for (const widget of this.widgets) {
            widget.component.clearCopies();
        }
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

        // setInterval(render, 500);
    }

    setConnectionStatus(connected) {
        this.connectionStatus.textContent = connected ? "Connected" : "Disconnected";
        this.connectionStatus.style.background = connected
            ? "var(--status-connected)"
            : "var(--status-disconnected)";
    }

    addEdgeControlButton(controls) {
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

        controls.appendChild(edgeButton);
        updateEdgeButton();
    }

    addControls(controls, graph) {
        const triggerWordLabel = document.createElement("label");
        triggerWordLabel.textContent = "Trigger word: ";
        triggerWordLabel.htmlFor = "id_trigger_word";

        const triggerWordInput = document.createElement("input");
        triggerWordInput.id = "id_trigger_word";
        triggerWordInput.type = "text";
        triggerWordInput.value = graph.getTriggerWord();
        triggerWordInput.classList.add("control-input");
        triggerWordInput.classList.add("numeric-control-input");

        triggerWordInput.addEventListener("input", () => {
            graph.setTriggerWord(String(triggerWordInput.value));
        });

        triggerWordLabel.appendChild(triggerWordInput);
        controls.appendChild(triggerWordLabel);

        // this.addEdgeControlButton(controls);

        const preTriggerLabel = document.createElement("label");
        preTriggerLabel.textContent = "PreTrigger:";
        controls.appendChild(preTriggerLabel);

        const preTriggerControl = new NumericControl({
            parent: controls,
            value: graph.getPreTriggerMs(),
            step: 10,
            inputStep: 1,
            min: -Infinity,
            max: -0,
            unit: "ms",
            onChange: (value) => graph.setPreTrigger(value)
        });

        const graphWidthLabel = document.createElement("label");
        graphWidthLabel.textContent = "View:";
        controls.appendChild(graphWidthLabel);

        const graphWidthControl = new NumericControl({
            parent: controls,
            value: graph.getGraphWidthMs(),
            step: 10,
            inputStep: 1,
            min: 0.001,
            unit: "ms",
            onChange: (value) => {
                graph.setgraphWidthMs(value);
            }
        });

        const autoSet = document.createElement("button");
        autoSet.textContent = "AutoSet";
        autoSet.classList.add("control-button");
        autoSet.addEventListener("click", () => {
            graph.autoSet();
        });
        controls.appendChild(autoSet);

        const separator = document.createElement("span");
        separator.classList.add("control-separator");
        controls.appendChild(separator);

        const autoButton = document.createElement("button");
        autoButton.textContent = "AUTO";
        autoButton.classList.add("control-button");
        autoButton.addEventListener("click", () => {
            graph.auto();
        });
        controls.appendChild(autoButton);

        const stopRunButton = document.createElement("button");
        stopRunButton.classList.add("control-button", "stop-run-button");

        const stopSpan = document.createElement("span");
        stopSpan.textContent = "STOP";
        const divider = document.createElement("span");
        divider.classList.add("stop-run-divider");

        const runSpan = document.createElement("span");
        runSpan.textContent = "RUN";

        stopRunButton.append(stopSpan, divider, runSpan);

        stopRunButton.addEventListener("click", () => {
            graph.toggleRunning();
        });

        graph.onStatusChanged = () => {
            const isRunning = graph.isRunning();
            stopRunButton.classList.toggle("running", isRunning);
            preTriggerControl.setValue(graph.getPreTriggerMs(), false);   // only display, notifying would reset the trigger mode
            graphWidthControl.setValue(graph.getGraphWidthMs(), false);
        };
        stopRunButton.classList.toggle("running", graph.isRunning());
        controls.appendChild(stopRunButton);

        const singleButton = document.createElement("button");
        singleButton.textContent = "SINGLE";
        singleButton.classList.add("control-button");
        singleButton.addEventListener("click", () => {
            graph.single();
        });
        controls.appendChild(singleButton);

        const triggerStatus = document.createElement("span");
        triggerStatus.classList.add("trigger-status");
        controls.appendChild(triggerStatus);

        const updateTriggerStatus = () => {
            const status = graph.getTriggerStatus();
            triggerStatus.textContent = status ?? "";
            triggerStatus.classList.toggle("waiting", status === "Wait");
            triggerStatus.classList.toggle("triggered", status === "Triggered");
            triggerStatus.classList.toggle("auto", status === "Auto");
            updateRecordingProgress();
        };

        // while a single capture records, the background fills up until recording stops
        let progressFrame = null;
        const updateRecordingProgress = () => {
            const progress = graph.getRecordingProgress();
            triggerStatus.classList.toggle("recording", progress !== null);
            triggerStatus.style.setProperty("--recording-progress", `${(progress ?? 0) * 100}%`);
            if (progress !== null && progressFrame === null) {
                progressFrame = requestAnimationFrame(() => {
                    progressFrame = null;
                    updateRecordingProgress();
                });
            }
        };
        const notifyStatusChanged = graph.onStatusChanged;
        graph.onStatusChanged = () => {
            notifyStatusChanged();
            updateTriggerStatus();
        };
        updateTriggerStatus();
    }

    addScope() {
        const graphPanel = document.getElementById("id_graph_panel");
        const graph = new Graph(this.collector);

        const controls = document.createElement("div");
        controls.classList.add("control-panel");

        this.addControls(controls, graph);

        const widget = new ResizableContainer({
            parent: graphPanel,
            component: graph,
            onClose: () => {
                this.widgets.delete(widget);
            }
        });

        widget.prepend(controls);
        this.widgets.add(widget);
        widget.select();    // a new graph is the one the keyboard controls
    }
}

const main = new Main();
main.init();
