from machine import Pin
import time

import _acme
import acme
import acme_extra
import helper
from acme import Motor, pins

led = Pin(pins.LED, Pin.OUT)
led.value(1)
time.sleep_ms(10)

m = acme.Motor(1)
m.gains(1, 2, 3)
m.run(0.5)
print(acme.pins.MOT1, _acme.LIMIT + 1, acme.ABI, m.speed, Motor.MAX_SPEED)
_acme.set_speed(1, 0.5)
enc = _acme.Encoder(3)
enc.set_limit(0, 100)
print(helper.blink(2), acme_extra.extra_local(), acme.extra.GAIN)
Motor(2).stop()
