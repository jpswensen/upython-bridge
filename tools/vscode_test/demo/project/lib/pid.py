class PID:
    """A small PID controller (no integral windup protection: keep ki small)."""

    def __init__(self, kp, ki, kd):
        self.kp, self.ki, self.kd = kp, ki, kd
        self._sum = 0.0
        self._last = 0.0

    def update(self, error):
        self._sum += error
        diff = error - self._last
        self._last = error
        return self.kp * error + self.ki * self._sum + self.kd * diff
