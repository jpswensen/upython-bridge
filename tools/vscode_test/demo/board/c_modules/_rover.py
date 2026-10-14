VERSION = "2.1.0"
PORTS = 2


def set_speed(port, value):
    pass


def stop_all():
    pass


def line(n):
    pattern = ((0.1, 0.9, 0.2), (0.2, 0.8, 0.1), (0.6, 0.5, 0.1), (0.1, 0.7, 0.4), (0.1, 0.9, 0.1))
    return pattern[n % len(pattern)]
