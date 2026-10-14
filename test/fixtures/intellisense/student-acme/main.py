from machine import Pin
import time
import asyncio

import _acme
import acme
import boardhelper
from acme import Motor

led = Pin(2, Pin.OUT)
led.value(1)
time.sleep_ms(10)

_acme.set_speed(1, 0.5)
speed = _acme.get_speed(1)
_acme.calibrate(1)
_acme.log("hello", 1, 2)
_acme.configure(kp=1, ki=2)
enc = _acme.Encoder(3)
enc.set_limit(0, 100)
print(boardhelper.board_name(), acme.__version__, _acme.MAX_CHANNELS)


async def main():
    await asyncio.sleep_ms(10)


Motor(1).run(0.5)
asyncio.run(main())
