import _acme


class Motor:
    MAX_SPEED = 100

    def __init__(self, n):
        self.n = n
        self._speed = 0

    def gains(self, kp, ki, kd):
        self.k = (kp, ki, kd)

    def run(self, speed):
        self._speed = speed

    def stop(self):
        self._speed = 0

    @property
    def speed(self):
        return self._speed
