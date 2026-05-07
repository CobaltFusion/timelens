const EventType = {
    OPEN: "open",           // only has a valid begin_time
    CLOSE: "close",         // only has a valid end_time
    DURATION: "duration",   // both begin_time + end_time are valid
    VALUE: "value"          // has a valid begin_time + value
};

function makeEvent(name, type, begin_time, end_time, groupId, value) {
    //console.log("make: %s, type: %s, b: %s, e: %s ", name, type, begin_time, end_time);
    return {
        name: name,
        type: type,
        begin_time: begin_time,
        end_time: end_time,
        groupId: groupId,
        value: value
    };
}

class Collector {
    constructor() {
        this.incoming = []; // this an array of structs, if GC becomes a problem, we should turn this into a struct of arrays for zero-reallocation
        this.running = true;

        // this uses the 'host' where we are loading this application from
        //this.ws = new WebSocket(`ws://${window.location.host}/ws`);

        this.ws = new WebSocket(`ws://172.16.2.17:8080/ws`);
        this.ws.onmessage = (event) => {

            const data = JSON.parse(event.data);
            // notice that the variables MUST correspond with the actual JSON field names here!
            let te = 0;
            let { name, cat, ph, pid, tid, ts } = data;

            const value = 0;
            let type = EventType.OPEN;
            if (ph === 'E') {
                type = EventType.CLOSE;
                te = ts;
                ts = 0;
            }
            const groupId = tid; // use tid as grouping for single line
            this.incoming.push(makeEvent(name, type, ts, te, groupId, value));
        }
    }

    clear() {
        console.log("clear");
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
        this.incoming.push(makeEvent("cycle", EventType.OPEN, 0, 0, "groupid"));
        this.incoming.push(makeEvent("capture_image", EventType.DURATION, 10 * 1000, 230 * 1000, "groupid"));

        this.incoming.push(makeEvent("process_image", EventType.OPEN, 231 * 1000, 0, "groupid"));
        this.incoming.push(makeEvent("set_outputs", EventType.DURATION, 310 * 1000, 400 * 1000, "groupid"));
        this.incoming.push(makeEvent("process_image", EventType.CLOSE, 0, 300 * 1000, "groupid")); // intentionally out-of-order
        //this.incoming.push(makeEvent("cycle", EventType.CLOSE, 0, 500*1000, "groupid")); // intentionally omitted
    }
}
