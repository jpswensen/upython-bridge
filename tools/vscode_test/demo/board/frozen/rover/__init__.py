# rover: the library built into the demo firmware (made up for the screenshots)
import _rover
from rover.motor import Motor
from rover.sensors import LineSensor, Distance

VERSION = _rover.VERSION


def stop_all():
    """Stop both motors."""
    _rover.stop_all()
