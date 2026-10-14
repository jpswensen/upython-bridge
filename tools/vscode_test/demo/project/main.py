# Lab 3: follow the black line with a PID controller
import json
import time

from rover import Motor, LineSensor
from pid import PID

with open("calibration.json") as f:
    cal = json.load(f)

left, right = Motor(1), Motor(2)
sensor = LineSensor()
pid = PID(cal["kp"], cal["ki"], cal["kd"])

for step in range(5):
    l, c, r = sensor.read()
    error = r - l
    turn = pid.update(error)
    left.speed(cal["base_speed"] - turn)
    right.speed(cal["base_speed"] + turn)
    print("step %d  sensors %.1f %.1f %.1f  turn %+.2f" % (step, l, c, r, turn))
    time.sleep(0.2)

left.stop()
right.stop()
print("done")
