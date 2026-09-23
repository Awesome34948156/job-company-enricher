// The only classic (non-module) script in the content-script world.
//
// Manifest V3 declared content scripts cannot be ES modules — `"type": "module"`
// is only valid on `background`. So this thin bootstrap dynamic-imports the real
// entry point, which lets the rest of the content code use normal ESM imports.
//
// If the import fails, the console message names the exact URL, which is the
// fastest way to diagnose a mistyped `web_accessible_resources` glob.

(async () => {
  const url = chrome.runtime.getURL('src/content/main.js');
  try {
    const mod = await import(url);
    await mod.start();
  } catch (err) {
    console.error('[JCE] content module failed to load:', url, err);
    console.error('[JCE] check that web_accessible_resources covers this path '
      + '(and that use_dynamic_url is false).');
  }
})();
