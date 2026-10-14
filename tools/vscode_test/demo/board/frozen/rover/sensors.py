import _rover


class LineSensor:
    """Three reflectance sensors under the front bumper."""

    def __init__(self):
        self._n = 0

    def read(self):
        self._n += 1
        return _rover.line(self._n)


class Distance:
    def cm(self):
        return 42.0
