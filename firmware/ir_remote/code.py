# IR Remote - v2.2
# Runs on a Raspberry Pi Pico (CircuitPython 10.x). Turns the ELEGOO kit's IR remote
# into a USB media remote for Spotify, and tells the lyric display about pause + sleep instantly.
#
# Wiring (IR receiver module -> Pico):
#   G (ground) -> GND       (physical pin 38)
#   R (power)  -> 3V3(OUT)  (physical pin 36)   3.3V only, never VBUS (5V)
#   Y (signal) -> GP22      (physical pin 29)
# (On the VBUS side, counting from the USB end: 3rd, 5th and 12th pins.)
#
# Libraries (copy into CIRCUITPY/lib from the CircuitPython 10.x library bundle):
#   adafruit_hid/   adafruit_irremote.mpy
#
# What it sends to the PC:
#   - Media keys (play/pause, next, previous, volume) like a normal USB keyboard
#   - Text lines over USB serial that the sync app listens for:
#       REMOTE:PLAY_PAUSE  -> the LCD pauses/resumes instantly
#       REMOTE:POWER       -> sleep mode (blank screen + pause), press again to wake

import board
import pulseio
import adafruit_irremote
import usb_hid                                   # lets the Pico act as a USB keyboard
from adafruit_hid.consumer_control import ConsumerControl          # the "media keys" part of a keyboard
from adafruit_hid.consumer_control_code import ConsumerControlCode # names for each media key

ir = pulseio.PulseIn(board.GP22, maxlen=120, idle_state=True)
decoder = adafruit_irremote.GenericDecode()
media = ConsumerControl(usb_hid.devices)

# LOOKUP TABLE: button number -> (name to print, media key to press)
# The ELEGOO remote sends (0, 255, button, check). Only the 3rd number changes per button.
BUTTONS = {
    2:   ("Play/Pause",  ConsumerControlCode.PLAY_PAUSE),
    194: ("Next song",   ConsumerControlCode.SCAN_NEXT_TRACK),
    34:  ("Previous",    ConsumerControlCode.SCAN_PREVIOUS_TRACK),
    98:  ("Volume up",   ConsumerControlCode.VOLUME_INCREMENT),
    168: ("Volume down", ConsumerControlCode.VOLUME_DECREMENT),
}
POWER = 162          # red power button: sleep mode (handled by the sync app, not a media key)

last_button = None   # remembers the last button, so holding VOL keeps changing volume

print("Remote ready!")

while True:
    pulses = decoder.read_pulses(ir)            # wait for the remote
    try:
        code = decoder.decode_bits(pulses)      # pulses -> (0, 255, button, check)
    except adafruit_irremote.IRNECRepeatException:
        # button is being HELD: only repeat for volume (not skip/pause/power)
        if last_button in (98, 168):
            media.send(BUTTONS[last_button][1])
        continue
    except adafruit_irremote.IRDecodeException:
        continue                                # garbled signal, ignore it

    # ignore signals from other remotes (like a TV remote)
    if len(code) != 4 or code[0] != 0 or code[1] != 255:
        continue

    button = code[2]                            # the 3rd number = which button

    if button == POWER:
        print("REMOTE:POWER")                   # tell the lyric display: sleep / wake
        last_button = None
        continue

    if button in BUTTONS:
        name, key = BUTTONS[button]             # look it up in the table
        if button == 2:
            print("REMOTE:PLAY_PAUSE")          # tell the lyric display right away
        media.send(key)                         # "press" the media key
        print(name)
        last_button = button
    else:
        print("Button not set up yet:", button)
        last_button = None
