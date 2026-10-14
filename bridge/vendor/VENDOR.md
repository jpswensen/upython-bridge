# Vendored dependencies (do not edit; update by re-running the steps below)

| Package | Version | Wheel SHA-256 | Licence |
|---|---|---|---|
| pyserial | 3.5 | `c4451db6ba391ca6ca299fb3ec7bae67a5c55dde170964c7a14ceefec02f2cf0` (pyserial-3.5-py2.py3-none-any.whl) | BSD-3-Clause |
| mpremote | 1.29.0 | `dedac688bcd65b9d4d5b7a66119332f2830000088321107994959333f53e41c8` (mpremote-1.29.0-py3-none-any.whl) | MIT |
| platformdirs | 4.3.8 | `ff7059bb7eb1179e2685604f4aaf157cfd9535242bd23742eadc3c13542139b4` (platformdirs-4.3.8-py3-none-any.whl) | MIT |

Re-vendor: `pip download --no-deps --only-binary=:all: pyserial==3.5 mpremote==1.29.0 platformdirs==4.3.8`, verify the hashes above, unzip the package directories (not `*.dist-info`) into this folder, keep licences in `licenses/`.
Pinning rules (D-08): mpremote stays 1.29.0 until a probe proves 1.30's changed soft-reset default is handled. The bridge's own code imports only `serial`; `mpremote` and `platformdirs` are loaded only by the oracle/differential tests and by mip/mount runners.
