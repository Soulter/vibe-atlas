const MAX_TERMINAL_HISTORY = 200000;

function trimHistory(history) {
  const text = String(history || '');
  return text.length > MAX_TERMINAL_HISTORY ? text.slice(-MAX_TERMINAL_HISTORY) : text;
}

function isCorruptedTerminalHistory(history) {
  const text = String(history || '');
  if (!text) {
    return false;
  }

  const oscColorSequenceCount = (text.match(/\u001b\](?:10|11);/g) || []).length;
  const brokenOscFragmentCount = (text.match(/(?:^|[\s\\])\](?:10|11);rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}/gi) || []).length;
  const rgbTripletCount = (text.match(/rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}/gi) || []).length;

  if (oscColorSequenceCount >= 2) {
    return true;
  }

  if (brokenOscFragmentCount >= 1) {
    return true;
  }

  if (rgbTripletCount >= 3 && /(?:\]10;|\]11;|\\\]10;|\\\]11;)/i.test(text)) {
    return true;
  }

  return false;
}

function getCorruptedHistoryStart(history) {
  const text = String(history || '');
  if (!text) {
    return -1;
  }

  const patterns = [
    /\u001b\](?:10|11);/g,
    /(?:^|[\s\\])\](?:10|11);rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}/gi,
    /(?:\\\]10;|\\\]11;|\]10;|\]11;)rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}/gi
  ];

  let earliest = -1;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (!match) {
      continue;
    }
    const index = match.index + (match[0].startsWith(' ') || match[0].startsWith('\\') ? 1 : 0);
    if (earliest === -1 || index < earliest) {
      earliest = index;
    }
  }

  return earliest;
}

function getRecoverableTerminalHistory(history) {
  const text = trimHistory(history);
  if (!text) {
    return '';
  }
  if (!isCorruptedTerminalHistory(text)) {
    return text;
  }

  const corruptionStart = getCorruptedHistoryStart(text);
  if (corruptionStart <= 0) {
    return '';
  }

  const candidate = text.slice(0, corruptionStart);
  const lastNewline = candidate.lastIndexOf('\n');
  if (lastNewline === -1) {
    return '';
  }

  return candidate.slice(0, lastNewline).trimEnd();
}

module.exports = {
  getRecoverableTerminalHistory,
  trimHistory
};
