# Eight Bus

A free browser synth built for the Akai MIDImix. Each of the controller's eight channel strips is a sound module (oscillator, FM, string, noise, kick, snare, hat, filter, delay or LFO), and any strip can patch into any other, including itself.

**Play it:** https://nokill-pedal-co.github.io/eight-bus/

- **Works without keys.** Strips hold notes or run their own Euclidean patterns, so the MIDImix alone is a whole instrument.
- **Patch bay on the hardware.** On the PATCH page, REC picks the source and MUTE connects it. The button lights and the on-screen copy of the unit both show the cables.
- **Soft takeover.** Knobs and faders catch the stored value as you move them past it, so the sound never jumps.
- **Six starting scenes:** Drone Choir, Euclid Kit, No-Input Mixer, Keyboard Poly, String Field and Dub Stabs.
- **Also plays from** a second MIDI keyboard, laptop keys or the screen. No MIDImix needed to try it.

Open it in Chrome or Edge for MIDI. It assumes the MIDImix's factory settings. Everything is in `index.html`, with the audio engine also in `eb-dsp.js`. There's nothing to install.

The MIDImix map comes from the MIT-licensed [akai-midimix](https://www.npmjs.com/package/akai-midimix) library and [Ardour's MIDImix map](https://github.com/Ardour/ardour/blob/master/share/midi_maps/AKAI_MIDIMix_Normal_Mode.map). Not affiliated with Akai Professional.
