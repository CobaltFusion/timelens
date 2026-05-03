const EventType = {
    OPEN: "open",           // only has a valid begin_time
    CLOSE: "close",         // only has a valid end_time
    DURATION: "duration",   // both begin_time + end_time are valid
    VALUE: "value"          // has a valid begin_time + value
};

function makeEvent(name, type, begin_time, end_time, value = 0) {
    return { name, type, begin_time, end_time, value }
}

class Collector {
    constructor() {
        this.incoming = []; // this an array of structs, if GC becomes a problem, we should turn this into a struct of arrays for zero-reallocation
        this.running = true;
        this.origin = 0;

        // this uses the 'host' where we are loading this application from
        this.ws = new WebSocket(`ws://${window.location.host}/ws`);
        this.ws.onmessage = (event) => {

            if (this.running === false) {
                this.origin = 0;
                return;
            }

            const data = JSON.parse(event.data);
            const { name, cat, ph, pid, tid, absTs } = data;

            if (this.origin === 0) {
                this.origin = absTs;
            }
            const ts = (absTs - this.origin) / 1000.0; // make times relative and in milliseconds

            const te = ts;
            const value = 0;
            let type = EventType.OPEN;
            if (ph === 'E') {
                type = EventType.CLOSE;
            }
            this.incoming.push(makeEvent(name, type, ts, te, value));
        }
    }

    clear() {
        // this clears the elements, incoming[0]  // undefined
        // but does not release the underlying storage, so its efficient and GC friendly
        this.incoming.length = 0;
    }

    data() {
        return this.incoming; // returns a reference, not a copy
    }

    stop() {
        this.running = false;
        // stop receiving more data.
    }

    start() {
        this.running = true;
        // re-start receiving data
    }

    reset() {
        this.clear();

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "control", action: "reset" }));
        }
    }

    dummy() {
        this.incoming.push(makeEvent("cycle", EventType.OPEN, 0));
        this.incoming.push(makeEvent("capture_image", EventType.DURATION, 10, 230));

        this.incoming.push(makeEvent("process_image", EventType.OPEN, 231, 0));
        this.incoming.push(makeEvent("set_outputs", EventType.DURATION, 310, 400));
        this.incoming.push(makeEvent("process_image", EventType.CLOSE, 0, 300)); // intentionally out-of-order
        //this.incoming.push(makeEvent("cycle", EventType.CLOSE, 0, 500)); // intentionally omitted
    }
}
