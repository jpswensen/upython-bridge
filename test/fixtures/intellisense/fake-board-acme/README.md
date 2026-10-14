Sources of the made-up "acme" board that tools/vscode_test/launch.py gives the fake board (tools/fakeboard.py) for the
IntelliSense host suites: `frozen/` = frozen modules (help('modules') lists them, the file system does not have them),
`c_modules/` = modules the fake board presents as built-in C modules, `files/` = files on the board's file system.
The extension learns about them only through the bridge (introspect.modules, fs.list, fs.get), as on a real board.
