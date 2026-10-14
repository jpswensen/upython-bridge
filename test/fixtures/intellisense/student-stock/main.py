from machine import Pin
import time
import network
import uasyncio

led = Pin(2, Pin.OUT)
led.on()
time.sleep_ms(10)
print(time.ticks_ms())
