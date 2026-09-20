
export class AudioAlerts {
    constructor() {
        this.audio = new AudioContext();
        this.audioEnabled = false;
        this.setAudio();

        this.types = ["sine", "square", "sawtooth", "triangle"];

        this.notes = [
            261.63, 277.18, 293.66, 311.13,
            329.63, 349.23, 369.99, 392.00,
            415.30, 440.00, 466.16, 493.88,
            523.25, 554.37, 587.33, 622.25,
            659.25, 698.46, 739.99, 783.99,
            830.61, 880.00, 932.33, 987.77
        ];
    }

    alertBeep() {
        this.beep(1300, 0.0, 0.05, "square");
    }

    beep(frequency, startTime, duration, type = "sine") {
        const osc = this.audio.createOscillator();
        const gain = this.audio.createGain();

        osc.type = type;
        osc.frequency.value = frequency;

        gain.gain.value = 0.2;

        osc.connect(gain);
        gain.connect(this.audio.destination);

        osc.start(this.audio.currentTime + startTime);
        osc.stop(this.audio.currentTime + startTime + duration);
    }

    randomNote(startTime = 0) {
        const duration = 0.02 + Math.random() * 0.08;

        this.beep(
            this.notes[Math.floor(Math.random() * this.notes.length)],
            startTime,
            duration,
            this.types[Math.floor(Math.random() * this.types.length)]
        );

        return duration;
    }

    playPseudoRandomSound(name) {
        let hash = 0;

        for (let i = 0; i < name.length; ++i) {
            hash = ((hash << 5) - hash) + name.charCodeAt(i);
            hash |= 0;
        }

        hash = Math.abs(hash);

        const note = this.notes[hash % this.notes.length];
        const type = this.types[(hash >> 4) % this.types.length];
        const duration = 0.02 + ((hash >> 8) % 80) / 1000;
        const startTime = ((hash >> 16) % 30) / 1000;

        this.beep(note, startTime, duration, type);
    }

    async toggleAudio() {
        this.audioEnabled = !this.audioEnabled;
        this.setAudio();
        return this.audioEnabled;
    }

    isAudioEnabled() {
        return this.audioEnabled;
    }

    setAudio() {
        if (this.audioEnabled) {
            this.audio.resume();
        } else {
            this.audio.suspend();
        }
    }

}

