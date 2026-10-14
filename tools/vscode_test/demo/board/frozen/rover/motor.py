import _rover


class Motor:
    MAX = 100

    def __init__(self, port):
        self.port = port
        self._speed = 0

    def speed(self, percent):
        self._speed = max(-self.MAX, min(self.MAX, percent))
        _rover.set_speed(self.port, self._speed)

    def stop(self):
        self.speed(0)

    @property
    def current(self):
        return self._speed
