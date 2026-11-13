// Returns the platform fonts Chrome actually used for each rendered line, via
// CDP CSS.getPlatformFontsForNode. This is measured after shaping, not guessed
// from the declared stack.

async function nodeIdFor(page, selector, index) {
  const cdp = page.__cdp || (page.__cdp = await page.context().newCDPSession(page));
  if (!page.__domEnabled) {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    page.__domEnabled = true;
  }
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const found = [];
  walk(root, found, selector, index);
  return { cdp, node: found[0] || null };
}

function walk(node, acc, selector, index) {
  if (!node) return;
  if (matches(node, selector)) acc.push(node);
  for (const child of node.children || []) walk(child, acc, selector, index + 1);
}

function matches(node, selector) {
  if (!node.attributes) return false;
  const attrs = {};
  for (let i = 0; i < node.attributes.length; i += 2) attrs[node.attributes[i]] = node.attributes[i + 1];
  if (selector.startsWith('[') && selector.endsWith(']')) {
    const [key, value] = selector.slice(1, -1).split('=');
    if (value === undefined) return attrs[key] !== undefined;
    return attrs[key] === value.replace(/^"|"$/g, '');
  }
  return false;
}

async function platformFontsFor(page, selector) {
  const { cdp } = await nodeIdFor(page, selector, 0);
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: false });
  const nodes = [];
  walkAll(root, nodes, selector);
  const texts = await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((node) => {
    const style = getComputedStyle(node);
    return { text: node.textContent, fontSize: style.fontSize, fontWeight: style.fontWeight };
  }), selector);
  const results = [];
  for (const node of nodes) {
    let fonts = [];
    try {
      const res = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: node.nodeId });
      fonts = res.fonts || [];
    } catch (error) {
      fonts = [{ error: error.message }];
    }
    const attrs = {};
    for (let i = 0; i < node.attributes.length; i += 2) attrs[node.attributes[i]] = node.attributes[i + 1];
    const computed = texts[results.length] || {};
    results.push({
      groupId: attrs['data-group'] || null,
      role: attrs['data-role'] || null,
      lineIndex: attrs['data-line-index'] != null ? Number(attrs['data-line-index']) : null,
      text: computed.text || '',
      fontSize: computed.fontSize || null,
      fontWeight: computed.fontWeight || null,
      fonts: fonts.map((font) => ({
        family: font.familyName,
        postScriptName: font.postScriptName,
        custom: Boolean(font.isCustomFont),
        glyphCount: font.glyphCount,
      })),
    });
  }
  return results;
}

function summarizeFallback(perLine) {
  const byRole = new Map();
  for (const line of perLine) {
    const key = `${line.groupId}/${line.role}`;
    if (!byRole.has(key)) byRole.set(key, new Map());
    const target = byRole.get(key);
    for (const font of line.fonts) {
      target.set(font.family, (target.get(font.family) || 0) + (font.glyphCount || 0));
    }
  }
  const out = [];
  for (const [key, families] of byRole) {
    out.push({ key, families: [...families.entries()].map(([family, glyphs]) => ({ family, glyphs })) });
  }
  return out;
}

function walkAll(node, acc, selector) {
  if (!node) return;
  if (matches(node, selector)) acc.push(node);
  for (const child of node.children || []) walkAll(child, acc, selector);
}

module.exports = { platformFontsFor, summarizeFallback };
