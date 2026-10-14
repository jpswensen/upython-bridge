"""tools.hwtest - the generic hardware test harness (spec: docs/hwtest-plan.md).

Modules: ``run_hw`` (CLI, guards, orchestration), ``confine`` (the only way a request can reach the bridge),
``tripwire``, ``phases`` (phases A-F, R and cleanup), ``resetphase`` (phase R, the gated reset tiers), ``fakedriver`` (a
stand-in for DTR/RTS so a FAKE board can take a hard reset), ``programs`` (harness-authored device programs), ``config``,
``report``.  Nothing here knows about a particular board or course: such facts live in a ``--config`` JSON file.
"""
