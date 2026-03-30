function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getTooltipText(target) {
  if (!target) {
    return '';
  }

  return target.getAttribute('data-tooltip')
    || target.getAttribute('title')
    || target.getAttribute('aria-label')
    || '';
}

module.exports = {
  clamp,
  getTooltipText
};
