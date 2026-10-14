/**
 * Every user-visible string of the sidebar and the status bar, in one place so wording stays consistent and can be reviewed
 * in one read. US English, for beginners: say what happened, then what to do next. Product names come from IDENTITY.
 */
import { IDENTITY } from '../identity';

export const FILES_TEXT = {
  connectLabel: (port: string): string => `Connect to ${port}`,
  connectDescription: 'Not connected',
  connectTooltip: (port: string): string =>
    `Click to connect to ${port}. Make sure the board is plugged in and that no other program (Thonny, another VS Code window or a terminal) is using it.`,
  connectingLabel: (port: string): string => `Connecting to ${port}...`,
  connectingTooltip: 'Opening the connection to the board. This usually takes a few seconds.',
  runningLabel: 'A program is running on the board',
  runningDescription: 'The file list updates when it stops',
  runningTooltip:
    'The board cannot list its files while your program runs. Press Stop in Board Actions or wait for the program to finish. The list then updates by itself.',
  emptyRootLabel: 'No files on the board yet',
  emptyRootDescription: 'Use Upload All Files in Sync utilities',
  emptyRootTooltip: (root: string): string =>
    `The folder ${root} on the board is empty. Create a file with the New File button above, or copy your workspace to the board with "Upload all files (Local → Board)" in Sync utilities.`,
  emptyDirLabel: 'This folder is empty',
  errorRootLabel: "Could not read the board's files",
  errorDirLabel: 'Could not read this folder',
  errorTooltip: (message: string, detail: string): string =>
    `${message}${detail !== '' ? `\n\nDetails: ${detail}` : ''}\n\nClick to try again.`,
  /** What a click does depends on whether the project has the file: `mine` yes, `board-only` no, `unknown` not checked yet. */
  localOnlyDescription: 'only on your computer',
  localOnlyDirTooltip: (devicePath: string): string => `A folder of your project that is not on the board yet. It will be created as ${devicePath} when its files are uploaded.`,
  fileTooltip: (devicePath: string, size: string, where: 'mine' | 'board-only' | 'unknown' = 'unknown'): string => {
    const click = where === 'mine'
      ? 'Open your copy in the project'
      : where === 'board-only'
        ? 'Only on the board: opens a read-only copy. A message then offers to copy it into your project'
        : 'Opens your copy in the project; a file that is only on the board opens as a read-only copy';
    return `${devicePath}\n${size}\nClick: ${click}.\nRight-click, "Open the Board's Copy (Read-Only)", shows the board's own version.`;
  },
  dirTooltip: (devicePath: string): string => `${devicePath}\nFolder on the board`,
  openTitle: 'Open File from Board',
  retryTitle: 'Try again',
} as const;

export const ACTIONS_TEXT = {
  runLabel: 'Run file',
  runNoFile: 'Open a Python file first',
  runUntitled: 'Untitled (save it first)',
  runTooltip: `Saves the current file and runs it on the board. The output appears in the ${IDENTITY.terminalName} terminal. If a program is already running, it is stopped first.`,
  replLabel: 'Open REPL',
  replDescription: 'Type Python on the board',
  replTooltip: `Opens the ${IDENTITY.terminalName} terminal where you can type Python and see the board's answers.`,
  stopLabel: 'Stop / Interrupt',
  stopRunning: 'Stops the running program',
  stopIdle: 'Nothing is running',
  stopTooltip: 'Sends Ctrl-C to the board to stop the running program. It is safe to press at any time and never resets the board.',
  resetLabel: 'Reset board...',
  resetDescription: 'Restart the board',
  resetTooltip: 'Restarts the board. You are asked which kind of reset you want and must confirm it.',
  intellisenseLabel: 'Set up IntelliSense',
  intellisenseDescription: 'Code completion for MicroPython',
  intellisenseTooltip: 'Shows you what will be created, then sets up code completion and import checking for MicroPython modules (machine, time, and the modules of your firmware). Nothing is changed before you agree.',
  doctorLabel: 'Doctor (check my setup)',
  doctorOk: 'Check Python, port and board',
  doctorProblem: 'A Python problem was found',
  doctorTooltip: 'Checks Python, the serial port and the board, and tells you what to fix when something is wrong.',
} as const;

export const SYNC_TEXT = {
  autoSyncLabel: (mode: string): string => `Auto-sync: ${mode.charAt(0).toUpperCase()}${mode.slice(1)}`,
  autoSyncDescription: {
    on: 'Uploads a file every time you save',
    off: 'Nothing is uploaded when you save',
    ask: 'Asks you when a board connects',
  },
  autoSyncTooltip: {
    on: 'Auto-sync is on: every file you save is uploaded to the board. Click to switch to the next setting (ask, on, off).',
    off: 'Auto-sync is off: saving a file does not change the board. Use "Upload all files" below or Run. Click to switch to the next setting (ask, on, off).',
    ask: 'Auto-sync asks you once, the first time a board connects in this workspace. Click to switch to the next setting (ask, on, off).',
  },
  pendingLabel: (count: number): string => `${count} ${count === 1 ? 'file' : 'files'} waiting`,
  pendingRunning: 'Waiting for the program to stop',
  pendingIdle: 'Not on the board yet',
  pendingTooltip: 'Files you saved that are not on the board yet. Uploads wait while a program is running on the board (an upload would interrupt it), while the board is not connected, and, for a board that was never synced with this folder on this computer, until you answer its review.',
  uploadAllLabel: 'Upload all files (Local → Board)',
  uploadAllTooltip: 'Copies the files of your workspace folder to the board. You see a plan before anything is changed.',
  downloadAllLabel: 'Download all files (Board → Local)',
  downloadAllTooltip: 'Copies the files on the board into your workspace folder. You are asked before anything on your computer is replaced.',
  clearLabel: 'Clear device files',
  clearTooltip: 'Deletes the files on the board. You are asked to confirm first.',
} as const;

export const STATUS_TEXT = {
  noBoard: 'No board',
  noBoardTooltip: 'No board is selected. Plug your board into a USB port of this computer, then click to choose its port.',
  states: {
    disconnected: 'Not connected',
    connecting: 'Connecting',
    ready: 'Ready',
    working: 'Working',
    running: 'Running',
  },
  unplugged: 'Unplugged',
  unpluggedTooltip: (port: string): string => `The board on ${port} was unplugged. Plug it back in, then click to connect again.`,
  busy: 'In use',
  busyFix: (port: string): string =>
    `${port} is in use by another program. Close Thonny, other VS Code windows or terminals that use the board, then click here to try again.`,
  disconnectedTooltip: (port: string): string => `Not connected to ${port}. Click to connect, or to choose another port.`,
  connectingTooltip: (port: string): string => `Connecting to ${port}...`,
  readyTooltip: 'Connected and waiting for you. Click to choose a different port.',
  workingTooltip: 'The board is busy with a file operation. Click to choose a different port.',
  runningTooltip: 'A program is running on the board. Press Stop in Board Actions to stop it. Click to choose a different port.',
  interpreterProblem: 'Python problem',
  interpreterTooltip: 'Python was not found or is not working, so the board cannot be reached. Click to open the Doctor, which tells you how to fix it.',
  autoSync: (mode: string, pending: number): string => {
    const label = `Auto-sync: ${mode.charAt(0).toUpperCase()}${mode.slice(1)}`;
    return pending > 0 ? `${label} (${pending} waiting)` : label;
  },
  autoSyncTooltip: {
    on: 'Auto-sync is on: every file you save is uploaded to the board. Click to change it.',
    off: 'Auto-sync is off: saving a file does not change the board. Click to change it.',
    ask: 'Auto-sync will ask you the first time a board connects. Click to change it.',
  },
  autoSyncPending: (count: number, running: boolean): string =>
    `${count} ${count === 1 ? 'file is' : 'files are'} waiting to be uploaded${running ? ' until the running program stops' : ''}.`,
} as const;
