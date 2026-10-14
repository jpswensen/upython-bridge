ABI = 3
LIMIT = 100
ENABLED = True
VERSION = "1.2.0"


def set_speed(ch, value):
    pass


def get_speed(ch):
    return 0


class Encoder:
    def __init__(self, n):
        self.n = n

    def read(self):
        return 0

    def reset(self):
        pass

    def set_limit(self, lo, hi):
        pass
