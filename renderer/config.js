const minScale = 0.35;
const maxScale = 2.2;
const zoomStep = 1.6;
const baseGridSize = 40;
const WORLD_WIDTH = 8000;
const WORLD_HEIGHT = 6000;
const UNTITLED_WORKSPACE = 'Untitled Workspace';

const TOOL_MODES = {
  HOVER: 'hover',
  WINDOW: 'window'
};

const terminalTheme = {
  background: '#1e1e1e',
  foreground: '#ffffff',
  cursor: '#aeafad',
  cursorAccent: '#1e1e1e',
  selection: '#264f78',
  black: '#000000',
  brightBlack: '#666666',
  red: '#cd3131',
  brightRed: '#f14c4c',
  green: '#0dbc79',
  brightGreen: '#23d18b',
  yellow: '#e5e510',
  brightYellow: '#f5f543',
  blue: '#2472c8',
  brightBlue: '#3b8eea',
  magenta: '#bc3fbc',
  brightMagenta: '#d670d6',
  cyan: '#11a8cd',
  brightCyan: '#29b8db',
  white: '#ffffff',
  brightWhite: '#ffffff'
};

const protipMessages = [
  'Cmd/Ctrl+S saves the workspace',
  'Cmd/Ctrl+T opens a new terminal',
  'Shift + drag pans the canvas',
  'Double click creates a note'
];

module.exports = {
  baseGridSize,
  maxScale,
  minScale,
  protipMessages,
  terminalTheme,
  TOOL_MODES,
  UNTITLED_WORKSPACE,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  zoomStep
};
