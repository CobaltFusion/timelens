function addKnob({
    parent,
    state,
    key,
    label = key,
    min = 0,
    max = 100,
    sensitivity = 0.5
}) {
    const wrapper = document.createElement("div");
    wrapper.style.display = "inline-block";
    wrapper.style.margin = "10px";
    wrapper.style.textAlign = "center";
    wrapper.style.userSelect = "none";

    const title = document.createElement("div");
    title.textContent = label;

    const knob = document.createElement("div");
    knob.style.width = "50px";
    knob.style.height = "50px";
    knob.style.border = "2px solid #00ff88";
    knob.style.borderRadius = "50%";
    knob.style.position = "relative";
    knob.style.margin = "5px auto";
    knob.style.cursor = "grab";

    //  pointer line
    const pointer = document.createElement("div");
    pointer.style.position = "absolute";
    pointer.style.width = "2px";
    pointer.style.height = "20px";
    pointer.style.background = "#00ff88";
    pointer.style.top = "5px";
    pointer.style.left = "50%";
    pointer.style.transform = "translateX(-50%)";

    knob.appendChild(pointer);

    let dragging = false;
    let lastY = 0;

    knob.addEventListener("mousedown", (e) => {
        dragging = true;
        lastY = e.clientY;
        knob.style.cursor = "grabbing";
    });

    window.addEventListener("mouseup", () => {
        dragging = false;
        knob.style.cursor = "grab";
    });

    window.addEventListener("mousemove", (e) => {
        if (!dragging) return;

        const deltaY = lastY - e.clientY;
        lastY = e.clientY;

        state[key] += deltaY * sensitivity;
        state[key] = Math.max(min, Math.min(max, state[key]));

        const angle = (state[key] - min) / (max - min) * 270 - 135;
        knob.style.transform = `rotate(${angle}deg)`;
    });

    wrapper.appendChild(title);
    wrapper.appendChild(knob);
    parent.appendChild(wrapper);
}

function add_demo_knobs() {

    const state = {
        speed: 10,
        offset: 50
    };

    const panel = document.getElementById("id_control_panel");

    addKnob({
        parent: panel,
        state: state,
        key: "speed",
        label: "Speed",
        min: 0,
        max: 50,
        sensitivity: 0.2
    });

    addKnob({
        parent: panel,
        state: state,
        key: "offset",
        label: "Offset",
        min: 0,
        max: 200,
        sensitivity: 1
    });
}

function addControlPair(parent, callback, getValue, setValue, unit = "") {
    const minusBtn = document.createElement("button");
    minusBtn.textContent = "-";

    const valueInput = document.createElement("input");
    valueInput.type = "text";
    valueInput.style.margin = "0 10px";
    valueInput.style.minWidth = "30px";
    valueInput.style.width = "40px";
    valueInput.style.textAlign = "center";

    function format(v) {
        return unit ? `${v} ${unit}` : `${v}`;
    }

    function parse(v) {
        const m = String(v).trim().match(/^[-+]?\d+(\.\d+)?$/);
        return m ? Number(m[0]) : NaN;
    }

    function syncDisplay() {
        valueInput.value = format(getValue());
    }

    syncDisplay();

    const plusBtn = document.createElement("button");
    plusBtn.textContent = "+";

    function update(dir) {
        callback(dir);
        syncDisplay();
    }

    minusBtn.addEventListener("click", () => update(-1));
    plusBtn.addEventListener("click", () => update(1));

    valueInput.addEventListener("change", () => {
        const v = parse(valueInput.value);

        if (!isNaN(v)) {
            setValue(v);
        }

        syncDisplay();
    });

    parent.appendChild(minusBtn);
    parent.appendChild(valueInput);
    parent.appendChild(plusBtn);
}

function addControlPairNumber(parent, callback, getValue, setValue, step = 1, unit = "") {
    const minusBtn = document.createElement("button");
    minusBtn.textContent = "-";

    const plusBtn = document.createElement("button");
    plusBtn.textContent = "+";

    const valueInput = document.createElement("input");
    valueInput.type = "number";
    valueInput.step = step;
    valueInput.style.margin = "0 10px";
    valueInput.style.minWidth = "60px";
    valueInput.style.width = "70px";
    valueInput.style.textAlign = "center";

    const unitSpan = document.createElement("span");
    unitSpan.textContent = unit ? ` ${unit}` : "";

    function syncDisplay() {
        valueInput.value = getValue();
    }

    syncDisplay();

    function update(dir) {
        callback(dir);
        syncDisplay();
    }

    minusBtn.addEventListener("click", () => update(-1));
    plusBtn.addEventListener("click", () => update(1));

    valueInput.addEventListener("change", () => {
        const v = Number(valueInput.value);

        if (!isNaN(v)) {
            setValue(v);
        }

        syncDisplay();
    });

    valueInput.addEventListener("keydown", (e) => {
        if (e.key === "ArrowUp") {
            e.preventDefault();
            update(1);
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            update(-1);
        }
    });

    parent.appendChild(minusBtn);
    parent.appendChild(valueInput);
    parent.appendChild(plusBtn);
    parent.appendChild(unitSpan);
}

class NumericControl {
    constructor({
        parent,
        value = 0,
        step = 1,
        min = -Infinity,
        max = Infinity,
        unit = "",
        onChange = null
    }) {
        this.parent = parent;
        this.value = value;
        this.step = step;
        this.min = min;
        this.max = max;
        this.unit = unit;
        this.onChange = onChange;

        if (!(parent instanceof HTMLElement)) {
            throw new TypeError("NumericControl: 'parent' must be a valid HTMLElement (is the name of the control correct?)");
        }

        this._build();
        this._sync();
    }

    _build() {

        this.div = document.createElement("div");
        this.div.style.display = "flex";
        this.div.style.flexDirection = "row";
        this.div.style.alignItems = "center";
        this.div.style.gap = "5px";

        this.minusBtn = document.createElement("button");
        this.minusBtn.textContent = "-";

        this.plusBtn = document.createElement("button");
        this.plusBtn.textContent = "+";

        this.input = document.createElement("input");
        this.input.type = "number";
        this.input.step = this.step;
        this.input.style.margin = "0 10px";
        this.input.style.minWidth = "30px";
        this.input.style.width = "30px";
        this.input.style.padding = "2px 2px 2px 10px";

        this.unitSpan = document.createElement("span");
        this.unitSpan.textContent = this.unit ? ` ${this.unit}` : "";

        this.div.appendChild(this.minusBtn);
        this.div.appendChild(this.input);
        this.div.appendChild(this.plusBtn);
        this.div.appendChild(this.unitSpan);

        this.parent.appendChild(this.div);

        this.minusBtn.addEventListener("click", () => this.change(-1));
        this.plusBtn.addEventListener("click", () => this.change(1));

        this.input.addEventListener("change", () => {
            const v = Number(this.input.value);
            if (!isNaN(v)) this.setValue(v);
        });

        this.input.addEventListener("keydown", (e) => {
            if (e.key === "ArrowUp") {
                e.preventDefault();
                this.change(1);
            } else if (e.key === "ArrowDown") {
                e.preventDefault();
                this.change(-1);
            }
        });
    }

    _sync() {
        this.input.value = this.value;
    }

    _clamp(v) {
        return Math.min(this.max, Math.max(this.min, v));
    }

    setValue(v) {
        this.value = this._clamp(v);
        this._sync();

        if (this.onChange) {
            this.onChange(this.value);
        }
    }

    getValue() {
        return this.value;
    }

    change(dir) {
        this.setValue(this.value + dir * this.step);
    }
}
