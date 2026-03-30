const { clipboard, ipcRenderer, shell } = require('electron');
const { Terminal } = require('xterm');
const {
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
} = require('./renderer/config');
const { getRecoverableTerminalHistory, trimHistory } = require('./renderer/history');
const { clamp, getTooltipText } = require('./renderer/utils');

const viewport = document.getElementById('viewport');
const canvas = document.getElementById('canvas');
const minimap = document.getElementById('minimap');
const minimapWorld = document.getElementById('minimap-world');
const minimapViewport = document.getElementById('minimap-viewport');
const appMenu = document.getElementById('app-menu');
const appMenuButton = document.getElementById('app-menu-button');
const appMenuPanel = document.getElementById('app-menu-panel');
const workspaceCurrentName = document.getElementById('workspace-current-name');
const workspaceListEl = document.getElementById('workspace-list');
const newWorkspaceBtn = document.getElementById('menu-new-workspace');
const saveWorkspaceBtn = document.getElementById('menu-save-workspace');
const saveWorkspaceAsBtn = document.getElementById('menu-save-workspace-as');
const zoomBarValue = document.getElementById('zoom-value');
const zoomOutBtn = document.getElementById('zoom-out');
const zoomInBtn = document.getElementById('zoom-in');
const emptyState = document.getElementById('empty-state');
const emptyStateNewTerminalBtn = document.getElementById('empty-state-new-terminal');
const emptyStateNewNoteBtn = document.getElementById('empty-state-new-note');
const contextMenu = document.getElementById('context-menu');
const contextAddBtn = document.getElementById('context-add-terminal');
const toolResetBtn = document.getElementById('tool-reset');
const toolHoverBtn = document.getElementById('tool-hover');
const toolWindowBtn = document.getElementById('tool-window');
const selectionBox = document.getElementById('selection-box');
const dialogOverlay = document.getElementById('dialog-overlay');
const dialogTitle = document.getElementById('dialog-title');
const dialogMessage = document.getElementById('dialog-message');
const dialogInput = document.getElementById('dialog-input');
const dialogCancel = document.getElementById('dialog-cancel');
const dialogConfirm = document.getElementById('dialog-confirm');
const appTooltip = document.getElementById('app-tooltip');
const menuSavedIndicator = document.getElementById('menu-saved-indicator');
const zoomProtip = document.getElementById('zoom-protip');
const zoomProtipText = document.getElementById('zoom-protip-text');

let panX = 0;
let panY = 0;
let scale = 1;
let isPanning = false;
let panOrigin = { x: 0, y: 0 };
let shiftPanMode = false;
const isMac = process.platform === 'darwin';

let dragging = null;
let resizing = null;
let isMiniMapDragging = false;
let miniMapDragOffset = { x: 0, y: 0 };
const terminalViews = new Map();
const noteViews = new Map();
let topWindowZIndex = 10;
let noteSeq = 1;
let selectedNoteId = null;
let noteDragging = null;
let noteDragIntent = null;
let noteResizing = null;
let emptyStateArmed = true;
let autoSaveTimer = 0;
let suppressAutoSave = false;
let menuWorldX = 0;
let menuWorldY = 0;
let isSelecting = false;
let selectionStart = { x: 0, y: 0 };
let currentWorkspace = {
  id: null,
  name: UNTITLED_WORKSPACE,
  createdAt: null,
  updatedAt: null
};
let workspaceList = [];
let dialogResolver = null;
let activeToolMode = TOOL_MODES.HOVER;
let saveIndicatorTimer = 0;
let protipIndex = 0;

function showTooltip(text, clientX, clientY) {
  if (!appTooltip || !text) {
    return;
  }
  appTooltip.textContent = text;
  appTooltip.classList.remove('hidden');
  const offset = 14;
  const maxLeft = window.innerWidth - appTooltip.offsetWidth - 10;
  const maxTop = window.innerHeight - appTooltip.offsetHeight - 10;
  const left = Math.min(clientX + offset, Math.max(10, maxLeft));
  const top = Math.min(clientY + offset, Math.max(10, maxTop));
  appTooltip.style.left = `${left}px`;
  appTooltip.style.top = `${top}px`;
}

function hideTooltip() {
  if (!appTooltip) {
    return;
  }
  appTooltip.classList.add('hidden');
}

function updateZoomBar() {
  if (zoomBarValue) {
    zoomBarValue.textContent = `${Math.round(scale * 100)}%`;
  }
}

function updateProtip() {
  if (!zoomProtipText || !protipMessages.length) {
    return;
  }
  zoomProtipText.textContent = protipMessages[protipIndex % protipMessages.length];
}

function advanceProtip() {
  if (!protipMessages.length) {
    return;
  }
  protipIndex = (protipIndex + 1) % protipMessages.length;
  updateProtip();
}

function showSavedIndicator() {
  if (!menuSavedIndicator) {
    return;
  }
  menuSavedIndicator.classList.remove('hidden');
  if (saveIndicatorTimer) {
    clearTimeout(saveIndicatorTimer);
  }
  saveIndicatorTimer = window.setTimeout(() => {
    saveIndicatorTimer = 0;
    menuSavedIndicator.classList.add('hidden');
  }, 1600);
}

function updateEmptyState() {
  if (!emptyState) {
    return;
  }
  const hasContent = terminalViews.size > 0 || noteViews.size > 0;
  emptyState.classList.toggle('hidden', !emptyStateArmed || hasContent);
}

function setEmptyStateArmed(nextValue) {
  emptyStateArmed = Boolean(nextValue);
  updateEmptyState();
}

function consumeEmptyState() {
  if (!emptyStateArmed) {
    return;
  }
  emptyStateArmed = false;
  updateEmptyState();
}

function isEmptyStateVisible() {
  return Boolean(emptyState && !emptyState.classList.contains('hidden'));
}

function applyTerminalStatus(view, status = 'idle') {
  if (!view?.wrapper) {
    return;
  }
  const nextStatus = ['idle', 'running', 'exited'].includes(status) ? status : 'idle';
  view.wrapper.dataset.status = nextStatus;
  if (view.statusLabel) {
    view.statusLabel.textContent = nextStatus;
  }
}

function setShiftPanMode(active) {
  shiftPanMode = Boolean(active);
  document.body.classList.toggle('shift-pan-mode', shiftPanMode);
}

function startViewportPan(event) {
  if (event.button !== 0 && event.button !== 1) {
    return false;
  }
  event.stopPropagation();
  isPanning = true;
  const p = toViewportPoint(event.clientX, event.clientY);
  panOrigin = { x: p.x - panX, y: p.y - panY };
  viewport.classList.add('panning');
  document.body.style.userSelect = 'none';
  event.preventDefault();
  return true;
}

function beginTerminalTitleEdit(view) {
  if (!view?.title || view.isEditingTitle) {
    return;
  }
  view.isEditingTitle = true;
  view.previousTitle = view.persistedTitle || view.title.textContent || `Terminal #${view.id}`;
  view.wrapper?.classList.add('is-editing-title');
  view.title.contentEditable = 'true';
  view.title.spellcheck = false;
  requestAnimationFrame(() => {
    view.title.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(view.title);
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

function finishTerminalTitleEdit(view, { cancel = false } = {}) {
  if (!view?.title || !view.isEditingTitle) {
    return;
  }
  const fallbackTitle = `Terminal #${view.id}`;
  const nextTitle = cancel
    ? (view.previousTitle || fallbackTitle)
    : (view.title.textContent || '').replace(/\s+/g, ' ').trim() || view.previousTitle || fallbackTitle;
  view.isEditingTitle = false;
  view.title.contentEditable = 'false';
  view.title.textContent = nextTitle;
  view.persistedTitle = nextTitle;
  view.previousTitle = null;
  view.wrapper?.classList.remove('is-editing-title');
  scheduleWorkspaceAutoSave();
}


function closeInputDialog(result = null) {
  if (!dialogOverlay || !dialogResolver) {
    return;
  }
  const resolver = dialogResolver;
  dialogResolver = null;
  dialogOverlay.classList.add('hidden');
  if (dialogInput) {
    dialogInput.value = '';
  }
  resolver(result);
}

function requestTextInput({
  title = 'Input',
  message = '',
  value = '',
  confirmLabel = 'Confirm'
} = {}) {
  if (!dialogOverlay || !dialogTitle || !dialogMessage || !dialogInput || !dialogConfirm) {
    return Promise.resolve(null);
  }

  if (dialogResolver) {
    closeInputDialog(null);
  }

  dialogTitle.textContent = title;
  dialogMessage.textContent = message;
  dialogInput.value = value;
  dialogConfirm.textContent = confirmLabel;
  dialogOverlay.classList.remove('hidden');

  return new Promise((resolve) => {
    dialogResolver = resolve;
    requestAnimationFrame(() => {
      dialogInput.focus();
      dialogInput.select();
    });
  });
}

function updateWorkspaceChrome() {
  if (workspaceCurrentName) {
    workspaceCurrentName.textContent = currentWorkspace.name || UNTITLED_WORKSPACE;
  }
  document.title = currentWorkspace.name && currentWorkspace.name !== UNTITLED_WORKSPACE
    ? `${currentWorkspace.name} · Vibe Atlas`
    : 'Vibe Atlas';
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function noteTextToHtml(value) {
  return escapeHtml(value).replace(/\n/g, '<br>');
}

function noteHtmlToText(value) {
  return String(value || '')
    .replace(/<div><br><\/div>/gi, '\n')
    .replace(/<div>/gi, '\n')
    .replace(/<\/div>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/^\n+/, '');
}

function setCurrentWorkspace(meta = {}) {
  currentWorkspace = {
    id: meta.id || null,
    name: meta.name || UNTITLED_WORKSPACE,
    createdAt: meta.createdAt || null,
    updatedAt: meta.updatedAt || null
  };
  updateWorkspaceChrome();
  renderWorkspaceList();
}

function workspaceSummaryLabel(item) {
  if (!item?.updatedAt) {
    return item?.name || UNTITLED_WORKSPACE;
  }
  const time = new Date(item.updatedAt);
  const suffix = Number.isNaN(time.getTime()) ? '' : ` · ${time.toLocaleString()}`;
  return `${item.name || UNTITLED_WORKSPACE}${suffix}`;
}

function renderWorkspaceList() {
  if (!workspaceListEl) {
    return;
  }

  workspaceListEl.innerHTML = '';
  if (!workspaceList.length) {
    const empty = document.createElement('div');
    empty.className = 'workspace-list-empty';
    empty.textContent = 'No saved workspaces yet';
    workspaceListEl.appendChild(empty);
    return;
  }

  workspaceList.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'workspace-list-item';
    if (item.id && item.id === currentWorkspace.id) {
      button.classList.add('active');
    }
    button.textContent = workspaceSummaryLabel(item);
    button.title = `打开工作区：${item.name || UNTITLED_WORKSPACE}`;
    button.addEventListener('click', async () => {
      await openWorkspace(item.id);
    });
    workspaceListEl.appendChild(button);
  });
}

async function refreshWorkspaceList() {
  const result = await ipcRenderer.invoke('workspace:list');
  workspaceList = result?.ok && Array.isArray(result.workspaces) ? result.workspaces : [];
  renderWorkspaceList();
}

async function restoreLastOpenedWorkspace() {
  const result = await ipcRenderer.invoke('workspace:last-opened');
  const id = result?.ok && result.id ? String(result.id) : null;
  if (!id) {
    return false;
  }

  await openWorkspace(id);
  return currentWorkspace.id === id;
}

function toggleAppMenu(forceOpen = null) {
  if (!appMenuPanel || !appMenuButton) {
    return;
  }
  const shouldOpen = forceOpen === null
    ? appMenuPanel.classList.contains('hidden')
    : Boolean(forceOpen);
  appMenuPanel.classList.toggle('hidden', !shouldOpen);
  appMenuButton.classList.toggle('active', shouldOpen);
}

function serializeTerminalView(view) {
  return {
    title: view.persistedTitle || view.title?.textContent || `Terminal #${view.id}`,
    left: Number(view.wrapper?.dataset?.x) || 0,
    top: Number(view.wrapper?.dataset?.y) || 0,
    width: view.wrapper?.offsetWidth || 640,
    height: view.wrapper?.offsetHeight || 420,
    history: trimHistory(view.history)
  };
}

function serializeNoteView(view) {
  return {
    text: String(view.content?.textContent || '').trim(),
    left: Number(view.el?.dataset?.x) || 0,
    top: Number(view.el?.dataset?.y) || 0,
    width: view.el?.offsetWidth || 220,
    color: view.color || '#fff8c4',
    fontSize: Number(view.fontSize) || 20,
    zIndex: Number(view.el?.style?.zIndex) || 5
  };
}

function getWorkspaceSnapshot(override = {}) {
  return {
    id: override.id === undefined ? currentWorkspace.id : override.id,
    name: override.name || currentWorkspace.name || UNTITLED_WORKSPACE,
    createdAt: override.createdAt === undefined ? currentWorkspace.createdAt : override.createdAt,
    viewport: {
      panX,
      panY,
      scale
    },
    windows: Array.from(terminalViews.values()).map((view) => serializeTerminalView(view)),
    notes: Array.from(noteViews.values())
      .map((view) => serializeNoteView(view))
      .filter((item) => item.text)
  };
}

async function persistWorkspaceSnapshotSilently() {
  if (!currentWorkspace.id) {
    return;
  }
  const result = await ipcRenderer.invoke('workspace:save', {
    workspace: getWorkspaceSnapshot()
  });
  if (result?.ok && result.workspace) {
    setCurrentWorkspace(result.workspace);
  }
}

function scheduleWorkspaceAutoSave() {
  if (!currentWorkspace.id || suppressAutoSave) {
    return;
  }
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
  }
  autoSaveTimer = window.setTimeout(() => {
    autoSaveTimer = 0;
    persistWorkspaceSnapshotSilently();
  }, 250);
}

async function saveWorkspaceState({ promptForName = false, forceNewId = false } = {}) {
  let name = currentWorkspace.name;
  let id = currentWorkspace.id;
  let createdAt = currentWorkspace.createdAt;

  if (promptForName || !name || name === UNTITLED_WORKSPACE) {
    const input = await requestTextInput({
      title: 'Save Workspace',
      message: 'Choose a name for this workspace.',
      value: name && name !== UNTITLED_WORKSPACE ? name : '',
      confirmLabel: 'Save'
    });
    if (!input) {
      return null;
    }
    name = input.trim();
    if (!name) {
      return null;
    }
  }

  if (forceNewId) {
    id = null;
    createdAt = null;
  }

  const result = await ipcRenderer.invoke('workspace:save', {
    workspace: getWorkspaceSnapshot({ id, name, createdAt })
  });

  if (!result?.ok || !result.workspace) {
    window.alert(result?.error || 'Failed to save workspace');
    return null;
  }

  setCurrentWorkspace(result.workspace);
  await refreshWorkspaceList();
  return result.workspace;
}

function clearAllTerminalWindows() {
  Array.from(terminalViews.keys()).forEach((id) => {
    destroyTerminalWindow(id);
  });
  updateEmptyState();
}

function clearAllNotes() {
  selectedNoteId = null;
  Array.from(noteViews.values()).forEach((view) => {
    if (view?.el?.parentElement) {
      view.el.parentElement.removeChild(view.el);
    }
  });
  noteViews.clear();
  updateEmptyState();
}

async function maybePersistCurrentWorkspace() {
  const hasWorkspaceContent = terminalViews.size > 0 || noteViews.size > 0;
  if (!hasWorkspaceContent && !currentWorkspace.id) {
    return true;
  }

  const shouldPromptForName = !currentWorkspace.id && hasWorkspaceContent;
  const saved = await saveWorkspaceState({ promptForName: shouldPromptForName });
  return Boolean(saved || currentWorkspace.id);
}

async function createWorkspace() {
  const persisted = await maybePersistCurrentWorkspace();
  if (!persisted) {
    return;
  }

  const input = await requestTextInput({
    title: 'New Workspace',
    message: 'Create a new workspace.',
    value: '',
    confirmLabel: 'Create'
  });
  if (!input) {
    return;
  }

  const name = input.trim();
  if (!name) {
    return;
  }

  suppressAutoSave = true;
  clearAllTerminalWindows();
  clearAllNotes();
  const result = await ipcRenderer.invoke('workspace:save', {
    workspace: {
      id: null,
      name,
      createdAt: null,
      windows: [],
      notes: []
    }
  });
  suppressAutoSave = false;

  if (!result?.ok || !result.workspace) {
    window.alert(result?.error || 'Failed to create workspace');
    return;
  }

  setCurrentWorkspace(result.workspace);
  setEmptyStateArmed(true);
  await refreshWorkspaceList();
  toggleAppMenu(false);
}

async function openWorkspace(id) {
  if (!id) {
    toggleAppMenu(false);
    return;
  }

  const isReloadingCurrentWorkspace = id === currentWorkspace.id;

  if (!isReloadingCurrentWorkspace) {
    const persisted = await maybePersistCurrentWorkspace();
    if (!persisted) {
      return;
    }
  }

  const result = await ipcRenderer.invoke('workspace:load', id);
  if (!result?.ok || !result.workspace) {
    window.alert(result?.error || 'Failed to open workspace');
    return;
  }

  suppressAutoSave = true;
  clearAllTerminalWindows();
  clearAllNotes();
  setCurrentWorkspace(result.workspace);
  setEmptyStateArmed((result.workspace.windows?.length || 0) === 0 && (result.workspace.notes?.length || 0) === 0);
  const hasRestoredTerminals = (result.workspace.windows?.length || 0) > 0;
  restoreViewportState(result.workspace.viewport, { allowScale: !hasRestoredTerminals });
  for (const item of result.workspace.windows || []) {
    try {
      await addTerminalAtPosition(item.left, item.top, item.width, item.height, {
        title: item.title,
        history: item.history
      });
    } catch (error) {
      console.error('Failed to restore workspace terminal', item, error);
    }
  }
  for (const item of result.workspace.notes || []) {
    try {
      createCanvasNote(item.left, item.top, item.text, item.width, {
        color: item.color,
        fontSize: item.fontSize,
        zIndex: item.zIndex,
        autofocus: false
      });
    } catch (error) {
      console.error('Failed to restore workspace note', item, error);
    }
  }
  const contentBounds = getWorkspaceContentBounds();
  if (!isBoundsFullyVisible(contentBounds)) {
    fitViewportToBounds(contentBounds, 80, { allowScale: !hasRestoredTerminals });
  }
  suppressAutoSave = false;
  await refreshWorkspaceList();
  toggleAppMenu(false);
}

function bringTerminalToFront(viewOrId) {
  const view = typeof viewOrId === 'string'
    ? terminalViews.get(String(viewOrId))
    : viewOrId;
  if (!view || !view.wrapper) {
    return;
  }

  topWindowZIndex += 1;
  view.wrapper.style.zIndex = String(topWindowZIndex);

  terminalViews.forEach((item) => {
    if (!item?.wrapper) {
      return;
    }
    item.wrapper.classList.toggle('is-active', item === view);
  });
}

function applyViewportToolMode(mode) {
  if (!toolHoverBtn || !toolWindowBtn) {
    return;
  }

  if (!Object.values(TOOL_MODES).includes(mode)) {
    return;
  }

  activeToolMode = mode;
  const btns = [
    { el: toolHoverBtn, mode: TOOL_MODES.HOVER },
    { el: toolWindowBtn, mode: TOOL_MODES.WINDOW }
  ];
  for (const item of btns) {
    item.el.classList.toggle('active', item.mode === activeToolMode);
  }

  viewport.classList.remove('mode-hover', 'mode-window');
  viewport.classList.add(`mode-${mode}`);
  hideSelectionBox();
}

function hideSelectionBox() {
  if (!selectionBox) {
    return;
  }
  isSelecting = false;
  document.body.style.userSelect = '';
  selectionBox.style.display = 'none';
  selectionBox.style.left = '0px';
  selectionBox.style.top = '0px';
  selectionBox.style.width = '0px';
  selectionBox.style.height = '0px';
}

function getMiniMapScale() {
  const usableWidth = minimapWorld.clientWidth;
  const usableHeight = minimapWorld.clientHeight;
  const sx = usableWidth / WORLD_WIDTH;
  const sy = usableHeight / WORLD_HEIGHT;
  const mapScale = Math.min(sx, sy);
  return {
    mapScale,
    insetX: (usableWidth - WORLD_WIDTH * mapScale) / 2,
    insetY: (usableHeight - WORLD_HEIGHT * mapScale) / 2
  };
}

function worldRectToScreenRect() {
  const worldX = (-panX) / scale;
  const worldY = (-panY) / scale;
  const worldW = viewport.clientWidth / scale;
  const worldH = viewport.clientHeight / scale;

  return {
    x: clamp(worldX, 0, WORLD_WIDTH),
    y: clamp(worldY, 0, WORLD_HEIGHT),
    w: clamp(worldW, 0, WORLD_WIDTH - clamp(worldX, 0, WORLD_WIDTH)),
    h: clamp(worldH, 0, WORLD_HEIGHT - clamp(worldY, 0, WORLD_HEIGHT))
  };
}

function getWorkspaceContentBounds() {
  const rects = [];

  terminalViews.forEach((view) => {
    if (!view?.wrapper) {
      return;
    }
    rects.push({
      left: Number(view.wrapper.dataset.x) || 0,
      top: Number(view.wrapper.dataset.y) || 0,
      width: view.wrapper.offsetWidth || 640,
      height: view.wrapper.offsetHeight || 420
    });
  });

  noteViews.forEach((view) => {
    if (!view?.el) {
      return;
    }
    rects.push({
      left: Number(view.el.dataset.x) || 0,
      top: Number(view.el.dataset.y) || 0,
      width: view.el.offsetWidth || 220,
      height: view.el.offsetHeight || Math.max(28, view.content?.offsetHeight || 28)
    });
  });

  if (!rects.length) {
    return null;
  }

  const left = Math.min(...rects.map((item) => item.left));
  const top = Math.min(...rects.map((item) => item.top));
  const right = Math.max(...rects.map((item) => item.left + item.width));
  const bottom = Math.max(...rects.map((item) => item.top + item.height));

  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  };
}

function isBoundsFullyVisible(bounds, padding = 40) {
  if (!bounds) {
    return true;
  }

  const viewRect = worldRectToScreenRect();
  return bounds.left >= viewRect.x + padding
    && bounds.top >= viewRect.y + padding
    && bounds.left + bounds.width <= viewRect.x + viewRect.w - padding
    && bounds.top + bounds.height <= viewRect.y + viewRect.h - padding;
}

function fitViewportToBounds(bounds, padding = 80, options = {}) {
  if (!bounds) {
    return;
  }

  const allowScale = options.allowScale !== false;
  const safeViewportWidth = Math.max(240, viewport.clientWidth - padding * 2);
  const safeViewportHeight = Math.max(180, viewport.clientHeight - padding * 2);
  const nextScale = allowScale
    ? clamp(
      Math.min(
        safeViewportWidth / Math.max(bounds.width, 1),
        safeViewportHeight / Math.max(bounds.height, 1),
        1
      ),
      minScale,
      maxScale
    )
    : 1;

  scale = nextScale;
  const centerX = bounds.left + bounds.width / 2;
  const centerY = bounds.top + bounds.height / 2;
  setPan(
    viewport.clientWidth / 2 - centerX * scale,
    viewport.clientHeight / 2 - centerY * scale
  );
  updateZoomBar();
}

function viewportRectInMinimap() {
  const { mapScale, insetX, insetY } = getMiniMapScale();
  const rect = worldRectToScreenRect();
  const x = insetX + rect.x * mapScale;
  const y = insetY + rect.y * mapScale;
  const w = Math.max(10, rect.w * mapScale);
  const h = Math.max(10, rect.h * mapScale);
  return {
    left: x,
    top: y,
    width: w,
    height: h
  };
}

function isPointInsideRect(x, y, rect) {
  return x >= rect.left
    && x <= rect.left + rect.width
    && y >= rect.top
    && y <= rect.top + rect.height;
}

function updateMiniMap() {
  const mapRect = viewportRectInMinimap();
  minimapViewport.style.left = `${mapRect.left}px`;
  minimapViewport.style.top = `${mapRect.top}px`;
  minimapViewport.style.width = `${mapRect.width}px`;
  minimapViewport.style.height = `${mapRect.height}px`;
}

function setPanFromWorldCenter(worldX, worldY) {
  const clampedX = clamp(worldX, 0, WORLD_WIDTH);
  const clampedY = clamp(worldY, 0, WORLD_HEIGHT);
  setPan(viewport.clientWidth / 2 - clampedX * scale, viewport.clientHeight / 2 - clampedY * scale);
}

function worldToMinimap(worldX, worldY) {
  const { mapScale, insetX, insetY } = getMiniMapScale();
  return {
    x: insetX + worldX * mapScale,
    y: insetY + worldY * mapScale
  };
}

function minimapToWorld(clientX, clientY) {
  const rect = minimapWorld.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const { mapScale, insetX, insetY } = getMiniMapScale();
  return {
    x: clamp((x - insetX) / mapScale, 0, WORLD_WIDTH),
    y: clamp((y - insetY) / mapScale, 0, WORLD_HEIGHT)
  };
}

function toViewportPoint(clientX, clientY) {
  const rect = viewport.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top
  };
}

function toWorldPoint(clientX, clientY) {
  const p = toViewportPoint(clientX, clientY);
  return {
    x: (p.x - panX) / scale,
    y: (p.y - panY) / scale
  };
}

function startWindowDrag(id, event) {
  if (!event.target.closest('.terminal-close') && !isPanning && !isMiniMapDragging) {
    const wrapped = terminalViews.get(String(id));
    const wrapper = wrapped?.wrapper;
    if (!wrapper) {
      return false;
    }
    bringTerminalToFront(wrapped);
    dragging = {
      id: String(id),
      pointerWorld: toWorldPoint(event.clientX, event.clientY),
      left: Number(wrapper.dataset.x) || 0,
      top: Number(wrapper.dataset.y) || 0
    };
    document.body.style.userSelect = 'none';
    event.preventDefault();
    return true;
  }
  return false;
}

function applyThemeToAllTerminals() {
  terminalViews.forEach((view) => {
    if (!view || !view.terminal) {
      return;
    }
    view.terminal.setOption('theme', terminalTheme);
  });
}

function getTerminalCellSize(term, body) {
  const dims = term?._core?._renderService?.dimensions;
  let cellWidth = Number(dims?.css?.cell?.width);
  let cellHeight = Number(dims?.css?.cell?.height);

  if (!Number.isFinite(cellWidth) || cellWidth <= 0) {
    const scaledWidth = Number(dims?.scaledCellWidth);
    if (Number.isFinite(scaledWidth) && scaledWidth > 0) {
      cellWidth = scaledWidth / Math.max(window.devicePixelRatio || 1, 1);
    }
  }

  if (!Number.isFinite(cellHeight) || cellHeight <= 0) {
    const scaledHeight = Number(dims?.scaledCellHeight);
    if (Number.isFinite(scaledHeight) && scaledHeight > 0) {
      cellHeight = scaledHeight / Math.max(window.devicePixelRatio || 1, 1);
    }
  }

  if (!Number.isFinite(cellWidth) || cellWidth <= 0 || !Number.isFinite(cellHeight) || cellHeight <= 0) {
    const styles = getComputedStyle(body);
    const fontSize = parseFloat(styles.fontSize) || 13;
    cellWidth = fontSize * 0.62;
    cellHeight = fontSize * 1.2;
  }

  return { cellWidth, cellHeight };
}

function getViewRectFromWorldRect(left, top, width, height) {
  return {
    x: left,
    y: top,
    w: Math.max(1, width),
    h: Math.max(1, height)
  };
}

function showSelectionBox(rect) {
  if (!selectionBox) {
    return;
  }
  if (rect.width <= 0 || rect.height <= 0) {
    selectionBox.style.width = '0px';
    selectionBox.style.height = '0px';
    return;
  }
  selectionBox.style.display = 'block';
  selectionBox.style.left = `${rect.left}px`;
  selectionBox.style.top = `${rect.top}px`;
  selectionBox.style.width = `${rect.width}px`;
  selectionBox.style.height = `${rect.height}px`;
}

function fitTerminalToBody(view) {
  const term = view?.terminal;
  const wrapper = view?.wrapper;
  if (!term || !wrapper) {
    return;
  }

  const body = wrapper.querySelector('.terminal-body');
  if (!body) {
    return;
  }

  const { cellWidth, cellHeight } = getTerminalCellSize(term, body);

  const cols = Math.max(10, Math.floor(body.clientWidth / cellWidth));
  const rows = Math.max(3, Math.floor(body.clientHeight / cellHeight));
  if (cols !== term.cols || rows !== term.rows) {
    term.resize(cols, rows);
    ipcRenderer.send('terminal:resize', { id: view.id, cols, rows });
  }
}

function scheduleFit(view) {
  if (!view || view.closed || view.resizeRaf) {
    return;
  }
  view.resizeRaf = requestAnimationFrame(() => {
    view.resizeRaf = 0;
    fitTerminalToBody(view);
  });
}

function applyTransform() {
  canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  const grid = baseGridSize * scale;
  viewport.style.backgroundSize = `${grid}px ${grid}px`;
  const offsetX = ((panX % grid) + grid) % grid;
  const offsetY = ((panY % grid) + grid) % grid;
  viewport.style.backgroundPosition = `${offsetX}px ${offsetY}px`;
  updateMiniMap();
}

function setPan(x, y) {
  panX = x;
  panY = y;
  applyTransform();
}

function resetViewport() {
  scale = 1;
  setPan(40, 40);
}

function restoreViewportState(viewportState = {}, options = {}) {
  const allowScale = options.allowScale !== false;
  scale = allowScale && Number.isFinite(Number(viewportState.scale))
    ? Number(viewportState.scale)
    : 1;
  setPan(
    Number.isFinite(Number(viewportState.panX)) ? Number(viewportState.panX) : 40,
    Number.isFinite(Number(viewportState.panY)) ? Number(viewportState.panY) : 40
  );
  updateZoomBar();
}

function setScale(nextScale, origin = null) {
  const clamped = Math.min(maxScale, Math.max(minScale, Number(nextScale) || 1));
  const originInView = origin || { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
  const world = toWorldPoint(
    originInView.x + viewport.getBoundingClientRect().left,
    originInView.y + viewport.getBoundingClientRect().top
  );
  panX = originInView.x - world.x * clamped;
  panY = originInView.y - world.y * clamped;
  scale = clamped;
  applyTransform();
  updateZoomBar();
}

function createTerminalWindow(id, left, top, width = 640, height = 420, options = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-window';
  wrapper.dataset.id = id;
  wrapper.dataset.x = String(left);
  wrapper.dataset.y = String(top);
  wrapper.style.left = `${left}px`;
  wrapper.style.top = `${top}px`;
  wrapper.style.width = `${Math.max(360, width)}px`;
  wrapper.style.height = `${Math.max(220, height)}px`;

  const header = document.createElement('div');
  header.className = 'terminal-header';

  const headerMain = document.createElement('div');
  headerMain.className = 'terminal-header-main';

  const status = document.createElement('span');
  status.className = 'terminal-status';

  const statusDot = document.createElement('span');
  statusDot.className = 'terminal-status-dot';

  const statusLabel = document.createElement('span');
  statusLabel.className = 'terminal-status-label';
  statusLabel.textContent = 'idle';

  const title = document.createElement('span');
  title.className = 'terminal-title';
  title.textContent = options.title || `Terminal #${id}`;
  title.title = '点击重命名终端';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'terminal-close';
  closeBtn.textContent = '×';
  closeBtn.title = '关闭终端';

  status.appendChild(statusDot);
  status.appendChild(statusLabel);
  headerMain.appendChild(title);
  headerMain.appendChild(status);
  header.appendChild(headerMain);
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'terminal-body';
  body.id = `terminal-body-${id}`;
  body.style.backgroundColor = terminalTheme.background;
  wrapper.style.backgroundColor = terminalTheme.background;

  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'terminal-resize-handle';
  resizeHandle.title = '调整终端大小';

  wrapper.appendChild(header);
  wrapper.appendChild(body);
  wrapper.appendChild(resizeHandle);
  canvas.appendChild(wrapper);

  const term = new Terminal({
    allowTransparency: false,
    altClickMovesCursor: true,
    bellStyle: 'none',
    cursorStyle: 'block',
    cursorBlink: true,
    drawBoldTextInBrightColors: true,
    fastScrollModifier: 'alt',
    fastScrollSensitivity: 5,
    fontSize: 13,
    fontFamily: '"Google Sans Code", Menlo, Monaco, Consolas, "Courier New", monospace',
    fontWeight: '400',
    fontWeightBold: '700',
    letterSpacing: 0,
    lineHeight: 1.2,
    macOptionClickForcesSelection: true,
    macOptionIsMeta: true,
    minimumContrastRatio: 4.5,
    rightClickSelectsWord: true,
    scrollback: 10000,
    scrollSensitivity: 1,
    tabStopWidth: 4,
    theme: terminalTheme,
    rendererType: 'canvas'
  });

  term.setOption('theme', terminalTheme);
  term.open(body);
  if (term.element) {
    term.element.style.backgroundColor = terminalTheme.background;
  }

  term.attachCustomKeyEventHandler((event) => {
    const usesPrimaryModifier = isMac ? event.metaKey : event.ctrlKey;
    if (!usesPrimaryModifier) {
      return true;
    }

    const key = String(event.key || '').toLowerCase();
    if (key === 'c' && term.hasSelection()) {
      clipboard.writeText(term.getSelection());
      return false;
    }
    if (key === 'a') {
      term.selectAll();
      return false;
    }

    return true;
  });

  if (typeof term.registerLinkMatcher === 'function') {
    term.registerLinkMatcher(
      /https?:\/\/[^\s<>"')\]]+/,
      (event, uri) => {
        if (!uri) {
          return;
        }
        event?.preventDefault?.();
        shell.openExternal(uri);
      },
      {
        willLinkActivate: (_event, uri) => Boolean(uri)
      }
    );
  }

  const view = {
    id,
    terminal: term,
    wrapper,
    title,
    body,
    status,
    statusLabel,
    history: trimHistory(options.history),
    persistedTitle: options.title || `Terminal #${id}`,
    resizeObserver: null,
    resizeRaf: 0,
    closed: false,
    isEditingTitle: false,
    previousTitle: null
  };
  terminalViews.set(id, view);
  bringTerminalToFront(view);
  applyTerminalStatus(view, 'idle');
  consumeEmptyState();
  updateEmptyState();
  scheduleWorkspaceAutoSave();

  const recoverableHistory = getRecoverableTerminalHistory(view.history);
  if (recoverableHistory) {
    try {
      view.history = recoverableHistory;
      term.write(recoverableHistory);
      if (!/[\r\n]$/.test(recoverableHistory)) {
        term.write('\r\n');
      }
    } catch (error) {
      console.error('Failed to restore terminal history', id, error);
    }
  } else if (view.history) {
    console.warn('Skipped corrupted terminal history during restore', id);
    view.history = '';
  }

  try {
    fitTerminalToBody(view);
    term.focus();
    term.refresh(0, Math.max(0, term.rows - 1));
  } catch (error) {
    console.error('Failed to finalize terminal view', id, error);
  }
  applyThemeToAllTerminals();

  wrapper.addEventListener('mousedown', () => {
    if (shiftPanMode) {
      return;
    }
    term.focus();
  });

  body.addEventListener('wheel', (event) => {
    if (shiftPanMode) {
      event.preventDefault();
      event.stopPropagation();
      setPan(panX - event.deltaX, panY - event.deltaY);
      return;
    }
    event.stopPropagation();
  }, { passive: false });

  term.onData((data) => {
    ipcRenderer.send('terminal:input', { id, data });
  });

  term.onTitleChange((titleText) => {
    if (titleText) {
      view.persistedTitle = titleText;
      title.textContent = titleText;
    }
  });

  closeBtn.addEventListener('click', () => {
    destroyTerminalWindow(id);
  });

  resizeHandle.addEventListener('mousedown', (event) => {
    if (shiftPanMode) {
      startViewportPan(event);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    bringTerminalToFront(id);
    resizing = {
      id: String(id),
      startX: event.clientX,
      startY: event.clientY,
      width: wrapper.offsetWidth,
      height: wrapper.offsetHeight
    };
    document.body.style.userSelect = 'none';
  });

  if (window.ResizeObserver) {
    view.resizeObserver = new ResizeObserver(() => {
      scheduleFit(view);
    });
    view.resizeObserver.observe(wrapper);
  }

  requestAnimationFrame(() => {
    scheduleFit(view);
  });

  header.addEventListener('mousedown', (event) => {
    if (event.target.closest('.terminal-close')) {
      return;
    }
    if (event.target.closest('.terminal-title') || view.isEditingTitle) {
      return;
    }
    if (shiftPanMode) {
      startViewportPan(event);
      return;
    }
    startWindowDrag(id, event);
  });

  wrapper.addEventListener('mousedown', (event) => {
    if (shiftPanMode) {
      startViewportPan(event);
      return;
    }
    bringTerminalToFront(view);
  });

  body.addEventListener('mousedown', (event) => {
    if (shiftPanMode) {
      startViewportPan(event);
      return;
    }
    bringTerminalToFront(view);
  });

  title.addEventListener('mousedown', (event) => {
    if (shiftPanMode) {
      startViewportPan(event);
      return;
    }
    event.stopPropagation();
  });

  title.addEventListener('click', (event) => {
    if (shiftPanMode) {
      return;
    }
    event.stopPropagation();
    beginTerminalTitleEdit(view);
  });

  title.addEventListener('keydown', (event) => {
    if (!view.isEditingTitle) {
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      finishTerminalTitleEdit(view);
      view.title.blur();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      finishTerminalTitleEdit(view, { cancel: true });
      view.title.blur();
      return;
    }
    event.stopPropagation();
  });

  title.addEventListener('blur', () => {
    finishTerminalTitleEdit(view);
  });

  term.onFocus(() => {
    bringTerminalToFront(view);
  });

  return view;
}

function syncNoteHeight(el) {
  if (!el) {
    return;
  }
  el.style.height = 'auto';
  el.style.height = `${Math.max(28, el.scrollHeight)}px`;
}

function getSelectedNoteView() {
  return selectedNoteId ? noteViews.get(selectedNoteId) : null;
}

function clearNoteSelection() {
  selectedNoteId = null;
  noteViews.forEach((view) => {
    view?.el?.classList.remove('is-active');
  });
}

function bringNoteToFront(viewOrId) {
  const view = typeof viewOrId === 'string'
    ? noteViews.get(String(viewOrId))
    : viewOrId;
  if (!view?.el) {
    return;
  }
  topWindowZIndex += 1;
  view.el.style.zIndex = String(topWindowZIndex);
}

function selectNote(viewOrId) {
  const view = typeof viewOrId === 'string'
    ? noteViews.get(String(viewOrId))
    : viewOrId;
  if (!view?.el) {
    return;
  }
  selectedNoteId = view.id;
  noteViews.forEach((item) => {
    item?.el?.classList.toggle('is-active', item === view);
  });
  bringNoteToFront(view);
}

function applyNoteStyle(view) {
  if (!view?.content) {
    return;
  }
  view.content.style.color = view.color;
  view.content.style.fontSize = `${view.fontSize}px`;
  if (view.colorInput) {
    view.colorInput.value = view.color;
  }
}

function removeCanvasNote(id) {
  const view = noteViews.get(String(id));
  if (!view) {
    return;
  }
  if (view.el?.parentElement) {
    view.el.parentElement.removeChild(view.el);
  }
  noteViews.delete(String(id));
  if (selectedNoteId === String(id)) {
    selectedNoteId = null;
  }
  updateEmptyState();
  scheduleWorkspaceAutoSave();
}

function startNoteDrag(view, event) {
  if (!view?.el) {
    return;
  }
  selectNote(view);
  noteDragging = {
    id: view.id,
    pointerWorld: toWorldPoint(event.clientX, event.clientY),
    left: Number(view.el.dataset.x) || 0,
    top: Number(view.el.dataset.y) || 0
  };
  document.body.style.userSelect = 'none';
  event.preventDefault();
}

function startNoteResize(view, event) {
  if (!view?.el) {
    return;
  }
  selectNote(view);
  noteResizing = {
    id: view.id,
    startClientX: event.clientX,
    width: view.el.offsetWidth || 220
  };
  document.body.style.userSelect = 'none';
  event.preventDefault();
}

function beginNoteDragIntent(view, event) {
  if (!view?.el) {
    return;
  }
  selectNote(view);
  noteDragIntent = {
    id: view.id,
    startClientX: event.clientX,
    startClientY: event.clientY,
    pointerWorld: toWorldPoint(event.clientX, event.clientY),
    left: Number(view.el.dataset.x) || 0,
    top: Number(view.el.dataset.y) || 0
  };
}

function createCanvasNote(left, top, text = '', width = 220, options = {}) {
  const id = `note-${noteSeq++}`;
  const el = document.createElement('div');
  el.className = 'canvas-note';
  el.dataset.id = id;
  el.dataset.x = String(left);
  el.dataset.y = String(top);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.width = `${Math.max(120, width)}px`;
  el.style.zIndex = String(Number.isFinite(Number(options.zIndex)) ? Number(options.zIndex) : 5);

  const toolbar = document.createElement('div');
  toolbar.className = 'canvas-note-toolbar';

  const sizeDownBtn = document.createElement('button');
  sizeDownBtn.type = 'button';
  sizeDownBtn.className = 'canvas-note-tool';
  sizeDownBtn.textContent = 'A-';
  sizeDownBtn.title = '减小字号';

  const sizeUpBtn = document.createElement('button');
  sizeUpBtn.type = 'button';
  sizeUpBtn.className = 'canvas-note-tool';
  sizeUpBtn.textContent = 'A+';
  sizeUpBtn.title = '增大字号';

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'canvas-note-color';
  colorInput.title = '修改文字颜色';

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'canvas-note-tool canvas-note-delete';
  deleteBtn.textContent = 'del';
  deleteBtn.title = '删除文字块';

  toolbar.appendChild(sizeDownBtn);
  toolbar.appendChild(sizeUpBtn);
  toolbar.appendChild(colorInput);
  toolbar.appendChild(deleteBtn);

  const content = document.createElement('div');
  content.className = 'canvas-note-content';
  content.contentEditable = 'true';
  content.spellcheck = false;
  content.innerHTML = text ? noteTextToHtml(text) : '';

  const widthHandle = document.createElement('div');
  widthHandle.className = 'canvas-note-width-handle';
  widthHandle.title = '拖拽调整文字块宽度';

  el.appendChild(toolbar);
  el.appendChild(content);
  el.appendChild(widthHandle);
  canvas.appendChild(el);

  const view = {
    id,
    el,
    toolbar,
    content,
    widthHandle,
    colorInput,
    color: options.color || '#fff8c4',
    fontSize: Number.isFinite(Number(options.fontSize)) ? Number(options.fontSize) : 20
  };
  noteViews.set(id, view);
  applyNoteStyle(view);
  syncNoteHeight(content);
  consumeEmptyState();
  updateEmptyState();
  scheduleWorkspaceAutoSave();

  content.addEventListener('input', () => {
    syncNoteHeight(content);
    scheduleWorkspaceAutoSave();
  });

  el.addEventListener('mousedown', (event) => {
    event.stopPropagation();
    selectNote(view);
  });

  toolbar.addEventListener('mousedown', (event) => {
    event.stopPropagation();
  });

  sizeDownBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    view.fontSize = Math.max(14, view.fontSize - 2);
    applyNoteStyle(view);
    syncNoteHeight(content);
    selectNote(view);
    scheduleWorkspaceAutoSave();
  });

  sizeUpBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    view.fontSize = Math.min(64, view.fontSize + 2);
    applyNoteStyle(view);
    syncNoteHeight(content);
    selectNote(view);
    scheduleWorkspaceAutoSave();
  });

  colorInput.addEventListener('input', (event) => {
    event.stopPropagation();
    view.color = colorInput.value || '#fff8c4';
    applyNoteStyle(view);
    selectNote(view);
    scheduleWorkspaceAutoSave();
  });

  deleteBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    removeCanvasNote(view.id);
  });

  content.addEventListener('focus', () => {
    selectNote(view);
  });

  content.addEventListener('mousedown', (event) => {
    event.stopPropagation();
    beginNoteDragIntent(view, event);
  });

  content.addEventListener('dblclick', (event) => {
    event.stopPropagation();
    selectNote(view);
  });

  widthHandle.addEventListener('mousedown', (event) => {
    event.stopPropagation();
    startNoteResize(view, event);
  });

  if (options.autofocus !== false) {
    requestAnimationFrame(() => {
      content.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(content);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    });
  }

  return view;
}

function destroyTerminalWindow(id) {
  const view = terminalViews.get(String(id));
  if (!view || view.closed) {
    return;
  }
  view.closed = true;
  view.terminal.dispose();
  ipcRenderer.send('terminal:close', String(id));

  if (view.wrapper?.parentElement) {
    view.wrapper.parentElement.removeChild(view.wrapper);
  }
  if (view.resizeObserver) {
    view.resizeObserver.disconnect();
  }
  if (view.resizeRaf) {
    cancelAnimationFrame(view.resizeRaf);
  }
  terminalViews.delete(String(id));
  document.body.style.userSelect = '';
  updateEmptyState();
  scheduleWorkspaceAutoSave();
}

function getViewportCenterWorldPoint() {
  const rect = viewport.getBoundingClientRect();
  const x = (-panX + rect.width / 2) / scale - 320;
  const y = (-panY + rect.height / 2) / scale - 210;
  return { x, y };
}

async function addTerminalAtPosition(left, top, width, height, options = {}) {
  const result = await ipcRenderer.invoke('terminal:create', { cols: 80, rows: 24 });
  if (!result || result.ok !== true || !result.id) {
    const detail = result?.detail;
    const summary = Array.isArray(detail) ? detail.map(item => `${item.shell} -> ${item.message}`).join('\n') : '';
    const errorMessage = result?.error ? `创建终端失败：${result.error}${summary ? `\n\n细节:\n${summary}` : ''}` : '创建终端失败';
    if (summary) {
      console.error('终端启动失败详情：', detail);
    }
    window.alert(errorMessage);
    applyViewportToolMode(TOOL_MODES.HOVER);
    return;
  }
  createTerminalWindow(
    String(result.id),
    left,
    top,
    Number.isFinite(width) ? width : 640,
    Number.isFinite(height) ? height : 420,
    options
  );
  applyViewportToolMode(TOOL_MODES.HOVER);
}

function startSelection(event) {
  if (event.button !== 0) {
    return;
  }
  const start = toViewportPoint(event.clientX, event.clientY);
  if (start.x < 0 || start.y < 0 || start.x > viewport.clientWidth || start.y > viewport.clientHeight) {
    return;
  }
  selectionStart = {
    x: clamp(start.x, 0, viewport.clientWidth),
    y: clamp(start.y, 0, viewport.clientHeight)
  };
  isSelecting = true;
  document.body.style.userSelect = 'none';
  selectionBox.style.display = 'block';
  showSelectionBox({
    left: selectionStart.x,
    top: selectionStart.y,
    width: 0,
    height: 0
  });
  event.preventDefault();
}

function updateSelection(event) {
  if (!isSelecting) {
    return;
  }
  const point = toViewportPoint(event.clientX, event.clientY);
  const left = clamp(Math.min(selectionStart.x, point.x), 0, viewport.clientWidth);
  const top = clamp(Math.min(selectionStart.y, point.y), 0, viewport.clientHeight);
  const width = clamp(Math.abs(point.x - selectionStart.x), 0, viewport.clientWidth);
  const height = clamp(Math.abs(point.y - selectionStart.y), 0, viewport.clientHeight);
  showSelectionBox({ left, top, width, height });
}

function commitSelection(event) {
  if (!isSelecting) {
    return;
  }
  isSelecting = false;
  const end = toViewportPoint(event.clientX, event.clientY);
  const rect = viewport.getBoundingClientRect();

  const x1 = clamp(selectionStart.x, 0, viewport.clientWidth);
  const y1 = clamp(selectionStart.y, 0, viewport.clientHeight);
  const x2 = clamp(end.x, 0, viewport.clientWidth);
  const y2 = clamp(end.y, 0, viewport.clientHeight);

  const worldStart = toWorldPoint(x1 + rect.left, y1 + rect.top);
  const worldEnd = toWorldPoint(x2 + rect.left, y2 + rect.top);
  const sel = getViewRectFromWorldRect(
    Math.min(worldStart.x, worldEnd.x),
    Math.min(worldStart.y, worldEnd.y),
    Math.abs(worldEnd.x - worldStart.x),
    Math.abs(worldEnd.y - worldStart.y)
  );

  if (sel.w < 10 || sel.h < 10) {
    hideSelectionBox();
    applyViewportToolMode(TOOL_MODES.HOVER);
    return;
  }

  if (activeToolMode === TOOL_MODES.WINDOW) {
    const width = Math.max(220, sel.w);
    const height = Math.max(130, sel.h);
    addTerminalAtPosition(sel.x, sel.y, width, height);
  }

  hideSelectionBox();
  applyViewportToolMode(TOOL_MODES.HOVER);
}

function beginToolMode(mode) {
  applyViewportToolMode(mode);
}

function showContextMenu(x, y, worldX, worldY) {
  if (!contextMenu) {
    addTerminalAtPosition(worldX, worldY);
    return;
  }

  const menuWidth = 170;
  const menuHeight = 40;
  const maxX = window.innerWidth - menuWidth;
  const maxY = window.innerHeight - menuHeight;

  contextMenu.style.left = `${Math.max(0, Math.min(x, maxX))}px`;
  contextMenu.style.top = `${Math.max(0, Math.min(y, maxY))}px`;
  contextMenu.classList.remove('hidden');
  menuWorldX = worldX;
  menuWorldY = worldY;
}

function hideContextMenu() {
  if (!contextMenu) {
    return;
  }
  contextMenu.classList.add('hidden');
}

viewport.addEventListener('contextmenu', (event) => {
  if (isEmptyStateVisible()) {
    event.preventDefault();
    return;
  }
  if (event.target.closest('.terminal-window, #minimap')) {
    hideContextMenu();
    return;
  }

  const rect = viewport.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
    hideContextMenu();
    return;
  }

  const world = toWorldPoint(event.clientX, event.clientY);
  event.preventDefault();
  showContextMenu(event.clientX, event.clientY, world.x, world.y);
});

viewport.addEventListener('dblclick', (event) => {
  if (event.target.closest('.terminal-window, #minimap, #tool-hub, #app-menu, #app-brand, #context-menu, #dialog-overlay, .canvas-note, #zoom-bar')) {
    return;
  }
  if (isEmptyStateVisible()) {
    consumeEmptyState();
    return;
  }
  const world = toWorldPoint(event.clientX, event.clientY);
  createCanvasNote(world.x, world.y, '', 220);
});

if (contextAddBtn) {
  contextAddBtn.addEventListener('click', async () => {
    hideContextMenu();
    const jitteredX = menuWorldX + (Math.random() * 120 - 60);
    const jitteredY = menuWorldY + (Math.random() * 120 - 60);
    await addTerminalAtPosition(jitteredX, jitteredY);
  });
}

if (appMenuButton) {
  appMenuButton.addEventListener('mousedown', (event) => {
    event.stopPropagation();
  });
  appMenuButton.addEventListener('click', async (event) => {
    event.stopPropagation();
    const opening = appMenuPanel?.classList.contains('hidden');
    if (opening) {
      await refreshWorkspaceList();
    }
    toggleAppMenu();
  });
}

if (appMenuPanel) {
  appMenuPanel.addEventListener('mousedown', (event) => {
    event.stopPropagation();
  });
  appMenuPanel.addEventListener('click', (event) => {
    event.stopPropagation();
  });
}

if (newWorkspaceBtn) {
  newWorkspaceBtn.addEventListener('click', async () => {
    consumeEmptyState();
    await createWorkspace();
  });
}

if (saveWorkspaceBtn) {
  saveWorkspaceBtn.addEventListener('click', async () => {
    consumeEmptyState();
    await saveWorkspaceState({ promptForName: !currentWorkspace.id });
    toggleAppMenu(false);
  });
}

if (saveWorkspaceAsBtn) {
  saveWorkspaceAsBtn.addEventListener('click', async () => {
    consumeEmptyState();
    await saveWorkspaceState({ promptForName: true, forceNewId: true });
    toggleAppMenu(false);
  });
}

if (emptyStateNewTerminalBtn) {
  emptyStateNewTerminalBtn.addEventListener('click', async () => {
    consumeEmptyState();
    const center = getViewportCenterWorldPoint();
    await addTerminalAtPosition(center.x, center.y);
  });
}

if (emptyStateNewNoteBtn) {
  emptyStateNewNoteBtn.addEventListener('click', () => {
    consumeEmptyState();
    const center = getViewportCenterWorldPoint();
    createCanvasNote(center.x + 210, center.y + 120, '', 220);
  });
}

if (dialogOverlay) {
  dialogOverlay.addEventListener('mousedown', (event) => {
    if (event.target === dialogOverlay) {
      closeInputDialog(null);
    }
  });
}

if (dialogCancel) {
  dialogCancel.addEventListener('click', () => {
    closeInputDialog(null);
  });
}

if (dialogConfirm) {
  dialogConfirm.addEventListener('click', () => {
    closeInputDialog(dialogInput?.value ?? '');
  });
}

if (dialogInput) {
  dialogInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      closeInputDialog(dialogInput.value);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeInputDialog(null);
    }
  });
}

document.addEventListener('mouseover', (event) => {
  const target = event.target?.closest?.('button, input[type="color"], .canvas-note-width-handle');
  const text = getTooltipText(target);
  if (!text) {
    hideTooltip();
    return;
  }
  showTooltip(text, event.clientX, event.clientY);
});

document.addEventListener('mousemove', (event) => {
  if (appTooltip?.classList.contains('hidden')) {
    return;
  }
  showTooltip(appTooltip.textContent || '', event.clientX, event.clientY);
});

document.addEventListener('mouseout', (event) => {
  const target = event.target?.closest?.('button, input[type="color"], .canvas-note-width-handle');
  if (!target) {
    return;
  }
  const related = event.relatedTarget?.closest?.('button, input[type="color"], .canvas-note-width-handle');
  if (related === target) {
    return;
  }
  hideTooltip();
});

if (toolHoverBtn) {
  toolHoverBtn.addEventListener('click', () => {
    consumeEmptyState();
    beginToolMode(TOOL_MODES.HOVER);
  });
}

if (toolResetBtn) {
  toolResetBtn.addEventListener('click', () => {
    consumeEmptyState();
    resetViewport();
  });
}

if (toolWindowBtn) {
  toolWindowBtn.addEventListener('click', () => {
    consumeEmptyState();
    beginToolMode(TOOL_MODES.WINDOW);
  });
}

if (zoomOutBtn) {
  zoomOutBtn.addEventListener('click', () => {
    consumeEmptyState();
    setScale(scale - 0.1);
  });
}

if (zoomInBtn) {
  zoomInBtn.addEventListener('click', () => {
    consumeEmptyState();
    setScale(scale + 0.1);
  });
}

window.addEventListener('mousedown', (event) => {
  if (appMenu && appMenu.contains(event.target)) {
    return;
  }
  toggleAppMenu(false);
  if (!contextMenu || contextMenu.classList.contains('hidden')) {
    return;
  }
  if (event.target && contextMenu.contains(event.target)) {
    return;
  }
  hideContextMenu();
});

viewport.addEventListener('mousedown', (event) => {
  if (!event.target.closest('.canvas-note')) {
    clearNoteSelection();
  }
  if (event.target.closest('.terminal-close, #minimap, #tool-hub, #context-menu, #selection-overlay, #app-menu, #app-brand, #dialog-overlay, #zoom-bar')) {
    return;
  }
  if (isEmptyStateVisible()) {
    return;
  }

  if (shiftPanMode || event.button === 1) {
    startViewportPan(event);
    return;
  }

  if (activeToolMode === TOOL_MODES.WINDOW) {
    startSelection(event);
    return;
  }

  if (activeToolMode === TOOL_MODES.HOVER && event.target.closest('.terminal-window')) {
    const id = event.target.closest('.terminal-window').dataset.id;
    startWindowDrag(id, event);
    return;
  }
});

viewport.addEventListener('wheel', (event) => {
  if (shiftPanMode) {
    event.preventDefault();
    setPan(panX - event.deltaX, panY - event.deltaY);
    return;
  }
  if (event.target.closest('.terminal-body')) {
    return;
  }
  if (isEmptyStateVisible()) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  if (event.ctrlKey) {
    const factor = Math.exp(-event.deltaY * 0.002);
    const origin = toViewportPoint(event.clientX, event.clientY);
    setScale(scale * factor, origin);
    return;
  }
  setPan(panX - event.deltaX, panY - event.deltaY);
}, { passive: false });

window.addEventListener('keydown', async (event) => {
  const key = String(event.key).toLowerCase();
  if (key === 'shift') {
    setShiftPanMode(true);
  }
  const isSupportedShortcut = (event.ctrlKey || event.metaKey) && ['t', 's', '+', '=', '-'].includes(key);
  if (isEmptyStateVisible()) {
    if (!isSupportedShortcut) {
      return;
    }
    consumeEmptyState();
  }
  if ((event.ctrlKey || event.metaKey) && key === 's') {
    event.preventDefault();
    const saved = await saveWorkspaceState({ promptForName: !currentWorkspace.id });
    if (saved) {
      showSavedIndicator();
    }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key === 't') {
    event.preventDefault();
    const center = getViewportCenterWorldPoint();
    addTerminalAtPosition(center.x, center.y);
    return;
  }
  if ((event.key === 'Backspace' || event.key === 'Delete') && selectedNoteId) {
    const selected = getSelectedNoteView();
    if (selected && document.activeElement !== selected.content) {
      event.preventDefault();
      removeCanvasNote(selected.id);
      return;
    }
  }
  if (!event.ctrlKey && !event.metaKey) {
    return;
  }
  const center = { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
  if (event.key === '+' || event.key === '=') {
    setScale(scale * zoomStep, center);
    event.preventDefault();
    return;
  }
  if (event.key === '-') {
    setScale(scale / zoomStep, center);
    event.preventDefault();
  }
});

window.addEventListener('keyup', (event) => {
  if (String(event.key).toLowerCase() === 'shift') {
    setShiftPanMode(false);
  }
});

window.addEventListener('blur', () => {
  setShiftPanMode(false);
});

window.addEventListener('mousemove', (event) => {
  if (isSelecting) {
    updateSelection(event);
    return;
  }

  if (noteResizing) {
    const view = noteViews.get(noteResizing.id);
    if (!view?.el) {
      noteResizing = null;
      return;
    }
    const nextWidth = Math.max(120, Math.min(640, noteResizing.width + (event.clientX - noteResizing.startClientX)));
    view.el.style.width = `${nextWidth}px`;
    syncNoteHeight(view.content);
    return;
  }

  if (noteDragIntent && !noteDragging) {
    const deltaX = event.clientX - noteDragIntent.startClientX;
    const deltaY = event.clientY - noteDragIntent.startClientY;
    if (Math.hypot(deltaX, deltaY) >= 4) {
      const view = noteViews.get(noteDragIntent.id);
      if (view) {
        noteDragging = {
          id: noteDragIntent.id,
          pointerWorld: noteDragIntent.pointerWorld,
          left: noteDragIntent.left,
          top: noteDragIntent.top
        };
        document.activeElement?.blur?.();
        document.body.style.userSelect = 'none';
      }
    }
  }

  if (noteDragging) {
    const view = noteViews.get(noteDragging.id);
    const el = view?.el;
    if (!el) {
      noteDragging = null;
      return;
    }
    const pointer = toWorldPoint(event.clientX, event.clientY);
    const nextLeft = noteDragging.left + (pointer.x - noteDragging.pointerWorld.x);
    const nextTop = noteDragging.top + (pointer.y - noteDragging.pointerWorld.y);
    el.style.left = `${nextLeft}px`;
    el.style.top = `${nextTop}px`;
    el.dataset.x = String(nextLeft);
    el.dataset.y = String(nextTop);
    return;
  }

  if (resizing) {
    const view = terminalViews.get(resizing.id);
    const wrapper = view?.wrapper;
    if (!wrapper) {
      resizing = null;
      return;
    }
    const nextWidth = Math.max(360, resizing.width + (event.clientX - resizing.startX));
    const nextHeight = Math.max(220, resizing.height + (event.clientY - resizing.startY));
    wrapper.style.width = `${nextWidth}px`;
    wrapper.style.height = `${nextHeight}px`;
    scheduleFit(view);
    return;
  }

  if (dragging) {
    const el = terminalViews.get(dragging.id)?.wrapper;
    if (!el) {
      dragging = null;
      return;
    }
    const pointer = toWorldPoint(event.clientX, event.clientY);
    const nextLeft = dragging.left + (pointer.x - dragging.pointerWorld.x);
    const nextTop = dragging.top + (pointer.y - dragging.pointerWorld.y);
    el.style.left = `${nextLeft}px`;
    el.style.top = `${nextTop}px`;
    el.dataset.x = String(nextLeft);
    el.dataset.y = String(nextTop);
    return;
  }

  if (!isPanning) {
    return;
  }
  const p = toViewportPoint(event.clientX, event.clientY);
  setPan(p.x - panOrigin.x, p.y - panOrigin.y);
});

window.addEventListener('mouseup', (event) => {
  const shouldAutoSaveLayout = Boolean(noteResizing || noteDragging || resizing || dragging);
  if (isSelecting) {
    commitSelection(event);
    applyViewportToolMode(activeToolMode);
    return;
  }
  noteResizing = null;
  noteDragIntent = null;
  noteDragging = null;
  resizing = null;
  isPanning = false;
  dragging = null;
  viewport.classList.remove('panning');
  document.body.style.userSelect = '';
  if (shouldAutoSaveLayout) {
    scheduleWorkspaceAutoSave();
  }
});

window.addEventListener('mouseleave', () => {
  if (isSelecting) {
    hideSelectionBox();
  }
  noteResizing = null;
  noteDragIntent = null;
  noteDragging = null;
  resizing = null;
  isPanning = false;
  dragging = null;
  viewport.classList.remove('panning');
  document.body.style.userSelect = '';
});

ipcRenderer.on('terminal:data', (_event, payload) => {
  const data = payload?.data ?? '';
  const view = terminalViews.get(String(payload?.id));
  if (!view || view.closed) return;
  view.history = trimHistory((view.history || '') + data);
  view.terminal.write(data);
});

ipcRenderer.on('terminal:exit', (_event, payload) => {
  const id = String(payload?.id);
  const view = terminalViews.get(id);
  if (!view) return;
  applyTerminalStatus(view, 'exited');
  view.title.textContent = `${view.persistedTitle || `Terminal #${id}`} (已退出)`;
});

ipcRenderer.on('terminal:status', (_event, payload) => {
  const id = String(payload?.id);
  const view = terminalViews.get(id);
  if (!view) {
    return;
  }
  applyTerminalStatus(view, payload?.status || 'idle');
});

setPan(40, 40);
applyViewportToolMode(activeToolMode);
applyThemeToAllTerminals();
setCurrentWorkspace(currentWorkspace);
updateZoomBar();
setEmptyStateArmed(true);
updateProtip();
if (zoomProtip) {
  zoomProtip.addEventListener('click', () => {
    advanceProtip();
  });
}

void (async () => {
  await refreshWorkspaceList();
  await restoreLastOpenedWorkspace();
})();

minimapWorld.addEventListener('mousedown', (event) => {
  if (isEmptyStateVisible()) {
    event.preventDefault();
    return;
  }
  const rect = minimapWorld.getBoundingClientRect();
  const clickX = event.clientX;
  const clickY = event.clientY;
  if (clickX < rect.left || clickX > rect.right || clickY < rect.top || clickY > rect.bottom) {
    return;
  }
  isMiniMapDragging = true;
  event.preventDefault();
  const localX = clickX - rect.left;
  const localY = clickY - rect.top;
  const preview = viewportRectInMinimap();
  if (isPointInsideRect(localX, localY, preview)) {
    miniMapDragOffset = {
      x: localX - (preview.left + preview.width / 2),
      y: localY - (preview.top + preview.height / 2)
    };
  } else {
    miniMapDragOffset = { x: 0, y: 0 };
  }
  const point = minimapToWorld(clickX - miniMapDragOffset.x, clickY - miniMapDragOffset.y);
  setPanFromWorldCenter(point.x, point.y);
});

window.addEventListener('mousemove', (event) => {
  if (!isMiniMapDragging) {
    return;
  }
  const point = minimapToWorld(
    event.clientX - miniMapDragOffset.x,
    event.clientY - miniMapDragOffset.y
  );
  setPanFromWorldCenter(point.x, point.y);
});

window.addEventListener('mouseup', () => {
  isMiniMapDragging = false;
  miniMapDragOffset = { x: 0, y: 0 };
});

window.addEventListener('resize', () => {
  applyTransform();
  terminalViews.forEach((view) => {
    scheduleFit(view);
  });
});
